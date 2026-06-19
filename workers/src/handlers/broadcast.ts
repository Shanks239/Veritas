/**
 * Broadcast feed to all registered agents and collect their predictions.
 * Validates responses, hashes predictions in BCS, submits commits on-chain.
 *
 * Runs during the deliberation phase of each window.
 * Idempotent: agents that have already committed are skipped.
 */

import { txCommit, type SuiClientType, type SuiKeypairType } from '../lib/sui';
import { txPlaceLimitOrder } from '../lib/deepbook';
import { hashPredictionBytes } from '../lib/bcs';
import {
  KV as KVKey,
  type Env,
  type WindowMeta,
  type FeedSnapshot,
  type AgentPrediction,
  type CommitRecord,
  type TickBudget,
} from '../types';

const AGENT_TIMEOUT_MS = 45_000; // deliberation_ms - 15s buffer

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Broadcast input payload to all registered agents.
 * For each valid response: hash, commit on-chain, store in KV.
 * Called once per cron tick during deliberation. Idempotent.
 */
export async function broadcastAndCommit(
  meta:    WindowMeta,
  client:  SuiClientType,
  keypair: SuiKeypairType,
  env:     Env,
  budget:  TickBudget,
): Promise<void> {
  const [feedRaw, agentsRaw] = await Promise.all([
    env.KV.get(KVKey.windowFeed(meta.windowId)),
    env.KV.get(KVKey.windowAgents(meta.windowId)),
  ]);

  if (!feedRaw) {
    console.warn(`[broadcast] no feed for window ${meta.windowId}`);
    return;
  }

  const feed:   FeedSnapshot = JSON.parse(feedRaw);
  const agents: string[]     = agentsRaw ? JSON.parse(agentsRaw) : await fetchRegisteredAgents(env);

  // Store agent list for this window if not yet cached
  if (!agentsRaw) {
    await env.KV.put(KVKey.windowAgents(meta.windowId), JSON.stringify(agents));
  }

  // Commit at most `budget.remaining` agents this tick. Already-committed agents
  // are skipped cheaply (no fetch/sign) and don't consume budget, so over the
  // ~5 ticks of a deliberation window every agent gets a turn. Idempotent.
  let committed = 0;
  for (const agent of agents) {
    if (budget.remaining <= 0) break;
    let didWork: boolean;
    try {
      didWork = await collectAndCommit(agent, meta, feed, client, keypair, env);
    } catch (err) {
      // The fetch/hash/sign work already burned CPU — count it so we still
      // respect the budget, and retry the agent on a later tick (idempotent).
      console.error(`[broadcast] agent ${agent} failed:`, err);
      didWork = true;
    }
    if (didWork) {
      budget.remaining--;
      committed++;
    }
  }

  if (committed > 0) console.log(`[broadcast] window ${meta.windowId}: committed ${committed} this tick`);
}

// ── Per-agent collection ──────────────────────────────────────────────────────

/**
 * Returns true only if it performed CPU-heavy work (hash + commit sign), so the
 * caller decrements the per-tick budget. Cheap outcomes — already committed, no
 * endpoint, or the agent being unreachable/returning bad data (which fail at the
 * fetch, before any signing) — return false so a down agent doesn't starve the
 * budget and block the others. A persistently-down agent simply gets a miss
 * recorded at resolve time.
 */
async function collectAndCommit(
  agentAddress: string,
  meta:         WindowMeta,
  feed:         FeedSnapshot,
  client:       SuiClientType,
  keypair:      SuiKeypairType,
  env:          Env,
): Promise<boolean> {
  // Skip if already committed this window
  const existingCommit = await env.KV.get(KVKey.windowCommit(meta.windowId, agentAddress));
  if (existingCommit) return false;

  const endpointRaw = await env.KV.get(KVKey.agentEndpoint(agentAddress));
  if (!endpointRaw) {
    console.warn(`[broadcast] no endpoint for agent ${agentAddress}`);
    return false;
  }
  const endpoint: string = JSON.parse(endpointRaw);

  // Fetch + validate. These fail before any signing (≈0 CPU), so treat a
  // failure as a cheap skip rather than spending the tick's commit budget.
  let prediction: AgentPrediction;
  try {
    const inputPayload = buildInputPayload(meta, feed);
    prediction = await fetchAgentPrediction(endpoint, inputPayload, env);
    validatePrediction(prediction, agentAddress, meta.windowId);
  } catch (err) {
    console.warn(`[broadcast] agent ${agentAddress} unavailable/invalid:`, err);
    return false;
  }

  // Hash in BCS — this is what gets committed on-chain
  const hashBytes = hashPredictionBytes(prediction);

  // Submit commit transaction
  const commitId = await txCommit(client, keypair, env, meta.windowId, hashBytes, meta.initialSharedVersion);

  // Store commit record in KV for reveal phase
  const record: CommitRecord = {
    windowId:     meta.windowId,
    agentAddress,
    commitId,
    hash:         Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    prediction,
  };

  await env.KV.put(
    KVKey.windowCommit(meta.windowId, agentAddress),
    JSON.stringify(record),
  );

  // Place the agent's limit order on Deepbook (best-effort — commit is already stored)
  if (env.BALANCE_MANAGER_ID) {
    // Deepbook parses clientOrderId as a u64, so it must be a numeric string —
    // derive a deterministic one from the window + agent (XOR of 48-bit slices).
    const clientOrderId = (
      BigInt('0x' + meta.windowId.slice(2, 14)) ^ BigInt('0x' + agentAddress.slice(2, 14))
    ).toString();
    txPlaceLimitOrder(client, keypair, env.BALANCE_MANAGER_ID, prediction.order, clientOrderId)
      .then(digest => console.log(`[broadcast] order placed for ${agentAddress}: ${digest}`))
      .catch(err  => console.error(`[broadcast] order failed for ${agentAddress}:`, err));
  }

  return true;
}

// ── Agent HTTP call ───────────────────────────────────────────────────────────

function buildInputPayload(meta: WindowMeta, feed: FeedSnapshot) {
  return {
    window_id:   meta.windowId,
    opens_at:    meta.opensAt,
    closes_at:   meta.closesAt,
    resolves_at: meta.resolvesAt,
    snapshot: {
      bids:      feed.bids,
      asks:      feed.asks,
      mid_price: feed.midPrice,
    },
    feeds: {
      coingecko_sui_usd: feed.coingeckoPrice,
      timestamp:         feed.timestamp,
    },
  };
}

async function fetchAgentPrediction(
  endpoint:     string,
  inputPayload: object,
  env:          Env,
): Promise<AgentPrediction> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  const init: RequestInit = {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(inputPayload),
    signal:  controller.signal,
  };

  // Cloudflare blocks plain fetch() to another Worker on the same workers.dev
  // zone (error 1042). When the endpoint is the agents Worker, route through the
  // service binding, which is allowed and uses the URL's path for routing.
  const sameZone = env.AGENTS_WORKER_HOST && (() => {
    try { return new URL(endpoint).host === env.AGENTS_WORKER_HOST; } catch { return false; }
  })();
  const doFetch = sameZone && env.AGENTS_SVC
    ? (e: string, i: RequestInit) => env.AGENTS_SVC!.fetch(e, i)
    : (e: string, i: RequestInit) => fetch(e, i);

  try {
    const res = await doFetch(endpoint, init);
    if (!res.ok) throw new Error(`Agent returned ${res.status}`);
    return await res.json() as AgentPrediction;
  } finally {
    clearTimeout(timer);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validatePrediction(
  p:            AgentPrediction,
  agentAddress: string,
  windowId:     string,
): void {
  if (p.windowId !== windowId) {
    throw new Error(`window_id mismatch from agent ${agentAddress}`);
  }

  if (p.agentAddress !== agentAddress) {
    throw new Error(`agentAddress mismatch: expected ${agentAddress}, got ${p.agentAddress}`);
  }

  // Probabilities must sum to 1 (within floating point tolerance)
  const sum = p.distribution.reduce((acc, b) => acc + b.probability, 0);
  if (Math.abs(sum - 1) > 0.01) {
    throw new Error(`Distribution probabilities sum to ${sum}, expected 1.0`);
  }

  // All probabilities non-negative
  for (const bucket of p.distribution) {
    if (bucket.probability < 0) {
      throw new Error(`Negative probability in bucket`);
    }
  }

  // Order size must be positive
  if (p.order.sizeUsdc <= 0) {
    throw new Error(`Order size must be positive`);
  }
}

// ── Registry helpers ──────────────────────────────────────────────────────────

/**
 * Fetch all registered agent addresses from Sui events.
 * Caches results in KV. In production, maintain an index via event subscription.
 */
async function fetchRegisteredAgents(env: Env): Promise<string[]> {
  const cached = await env.KV.get('agents:registered');
  if (cached) return JSON.parse(cached);

  // TODO: query AgentRegistered events from Sui and extract agent addresses
  // For hackathon: return hardcoded test agents
  const agents: string[] = [];
  await env.KV.put('agents:registered', JSON.stringify(agents), { expirationTtl: 300 });
  return agents;
}
