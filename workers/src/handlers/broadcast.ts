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

  // Broadcast to all agents in parallel, respecting timeout
  const results = await Promise.allSettled(
    agents.map(agent => collectAndCommit(agent, meta, feed, client, keypair, env)),
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  console.log(`[broadcast] window ${meta.windowId}: ${succeeded} committed, ${failed} failed/skipped`);
}

// ── Per-agent collection ──────────────────────────────────────────────────────

async function collectAndCommit(
  agentAddress: string,
  meta:         WindowMeta,
  feed:         FeedSnapshot,
  client:       SuiClientType,
  keypair:      SuiKeypairType,
  env:          Env,
): Promise<void> {
  // Skip if already committed this window
  const existingCommit = await env.KV.get(KVKey.windowCommit(meta.windowId, agentAddress));
  if (existingCommit) return;

  const endpointRaw = await env.KV.get(KVKey.agentEndpoint(agentAddress));
  if (!endpointRaw) {
    console.warn(`[broadcast] no endpoint for agent ${agentAddress}`);
    return;
  }
  const endpoint: string = JSON.parse(endpointRaw);

  // POST input payload to agent
  const inputPayload = buildInputPayload(meta, feed);
  const prediction   = await fetchAgentPrediction(endpoint, inputPayload);

  // Validate
  validatePrediction(prediction, agentAddress, meta.windowId);

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
    const clientOrderId = `${meta.windowId.slice(0, 8)}-${agentAddress.slice(2, 10)}`;
    txPlaceLimitOrder(client, keypair, env.BALANCE_MANAGER_ID, prediction.order, clientOrderId)
      .then(digest => console.log(`[broadcast] order placed for ${agentAddress}: ${digest}`))
      .catch(err  => console.error(`[broadcast] order failed for ${agentAddress}:`, err));
  }
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
): Promise<AgentPrediction> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(inputPayload),
      signal:  controller.signal,
    });

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
