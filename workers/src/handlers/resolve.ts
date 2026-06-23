/**
 * Resolve window + score all agents after horizon elapses.
 *
 * Per window:
 *   1. Fetch outcome price from Deepbook
 *   2. Call window::resolve() on-chain
 *   3. For each committed agent:
 *        a. Retrieve raw prediction from KV
 *        b. Compute Brier, PnL, drawdown, composite
 *        c. Upload prediction JSON to IPFS (or Walrus) → get CID
 *        d. Call commit::reveal() with preimage + CID
 *        e. Call agent_profile::record_score()
 *   4. For non-committed agents: call record_miss()
 */

import {
  txResolveWindow,
  txReveal,
  txRecordScore,
  txRecordMiss,
  txDistributeRevenue,
  readTotalStake,
  type SuiClientType,
  type SuiKeypairType,
} from '../lib/sui';
import { fetchMidPrice }                from '../lib/feed';
import { computeScores, computePnL, scaleForChain } from '../lib/scoring';
import { encodeForCommit }              from '../lib/bcs';
import {
  KV as KVKey,
  type Env,
  type WindowMeta,
  type CommitRecord,
  type TickBudget,
} from '../types';

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve + score a window, resumable across cron ticks and bounded by `budget`.
 * Each call spends at most `budget.remaining` operations (the on-chain resolve,
 * then one agent's score/miss each), persisting progress in `meta` so the next
 * tick continues where this one stopped. Returns true once the window is fully
 * resolved and every agent has been scored or marked missed.
 */
export async function resolveAndScore(
  meta:    WindowMeta,
  client:  SuiClientType,
  keypair: SuiKeypairType,
  env:     Env,
  budget:  TickBudget,
): Promise<boolean> {
  const address = keypair.toSuiAddress();

  // 1. Outcome price — fetched once (no tx), then cached in meta.
  if (meta.outcomePrice === undefined) {
    meta.outcomePrice = await fetchMidPrice(client, address, env.SUI_NETWORK, env.COINGECKO_API_KEY);
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
  }
  const outcomePrice = meta.outcomePrice;

  // 2. Resolve window on-chain — once, costs one budget op.
  if (!meta.resolvedOnChain) {
    if (budget.remaining <= 0) return false;
    budget.remaining--;
    try {
      await txResolveWindow(client, keypair, env, meta.windowId, outcomePrice);
      console.log(`[resolve] window ${meta.windowId} resolved at price ${outcomePrice}`);
    } catch (err) {
      const m = String(err);
      // E_ALREADY_RESOLVED (abort code 2): the window was resolved on-chain on
      // an earlier run whose KV meta never advanced. Treat as done and score.
      if (m.includes('Some("resolve")') && m.includes('}, 2)')) {
        console.log(`[resolve] window ${meta.windowId} already resolved on-chain — proceeding to score`);
      } else {
        // Horizon not elapsed yet, or a transient RPC error — retry next tick.
        console.warn(`[resolve] window ${meta.windowId} resolve deferred: ${m.slice(0, 140)}`);
        return false;
      }
    }
    meta.resolvedOnChain = true;
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
  }

  // 3. Score agents — a few per tick, tracking progress in meta.scoredAgents.
  const agentsRaw = await env.KV.get(KVKey.windowAgents(meta.windowId));
  const agents: string[] = agentsRaw ? JSON.parse(agentsRaw) : [];
  const scored = new Set(meta.scoredAgents ?? []);

  for (const agent of agents) {
    if (scored.has(agent)) continue;
    if (budget.remaining <= 0) break;
    budget.remaining--;
    try {
      await scoreAgent(agent, meta, outcomePrice, client, keypair, env);
    } catch (err) {
      // CPU already spent; mark done so we don't loop forever on one agent.
      console.error(`[resolve] scoring ${agent} failed:`, err);
    }
    scored.add(agent);
    meta.scoredAgents = [...scored];
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
  }

  const allScored = agents.every(a => scored.has(a));
  if (!allScored) return false;

  // 4. Optional pull-model revenue distribution. Opt-in via env to protect the
  // free-tier cron CPU/gas budget; accrues delegator rewards only for agents
  // that have stake behind them. Resumable across ticks via distributedAgents.
  if (env.ENABLE_REVENUE_DISTRIBUTION === '1') {
    return distributeWindowRevenue(meta, agents, client, keypair, env, budget);
  }
  return true;
}

// ── Revenue distribution (opt-in) ───────────────────────────────────────────

/**
 * Reward pool per scored window, scaled by the agent's composite score
 * (which is in [0,1]). A perfect window pays out this much SUI total — 80% to
 * the agent, 20% split pro-rata into delegators' claimable balances.
 */
const MAX_REWARD_MIST = 50_000_000;   // 0.05 SUI

/**
 * For each committed agent that has delegators, distribute a performance-scaled
 * reward so delegators accrue a claimable balance. Pre-checks (KV score read +
 * read-only stake lookup) are free; only the on-chain distribute tx spends from
 * the tick budget. Marks each agent done so the pass resumes cleanly next tick.
 */
async function distributeWindowRevenue(
  meta:    WindowMeta,
  agents:  string[],
  client:  SuiClientType,
  keypair: SuiKeypairType,
  env:     Env,
  budget:  TickBudget,
): Promise<boolean> {
  const done = new Set(meta.distributedAgents ?? []);

  for (const agent of agents) {
    if (done.has(agent)) continue;

    // Cheap pre-checks: needs a recorded score, positive composite, and stake.
    let rewardMist = 0n;
    const scoreRaw = await env.KV.get(KVKey.windowScore(meta.windowId, agent));
    if (scoreRaw) {
      const composite = (JSON.parse(scoreRaw) as { composite?: number }).composite ?? 0;
      if (composite > 0) {
        const stake = await readTotalStake(client, env, agent);
        if (stake > 0n) rewardMist = BigInt(Math.round(composite * MAX_REWARD_MIST));
      }
    }

    if (rewardMist > 0n) {
      if (budget.remaining <= 0) return false;   // out of budget — resume next tick
      budget.remaining--;
      try {
        await txDistributeRevenue(client, keypair, env, agent, meta.windowId, rewardMist);
        console.log(`[resolve] distributed ${rewardMist} MIST for ${agent} (window ${meta.windowId})`);
      } catch (err) {
        console.error(`[resolve] distribute failed for ${agent}:`, err);
      }
    }

    done.add(agent);
    meta.distributedAgents = [...done];
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
  }

  return agents.every(a => done.has(a));
}

// ── Per-agent scoring ─────────────────────────────────────────────────────────

async function scoreAgent(
  agentAddress: string,
  meta:         WindowMeta,
  outcomePrice: number,
  client:       SuiClientType,
  keypair:      SuiKeypairType,
  env:          Env,
): Promise<void> {
  const commitRaw = await env.KV.get(KVKey.windowCommit(meta.windowId, agentAddress));

  if (!commitRaw) {
    // Agent did not commit — record miss for decay purposes
    const profileId = await env.KV.get(`agent:${agentAddress}:profile_id`);
    if (profileId) {
      await txRecordMiss(client, keypair, env, profileId);
    }
    return;
  }

  const record: CommitRecord = JSON.parse(commitRaw);

  // Compute score components
  if (meta.entryPrice === undefined) {
    console.error(`[resolve] window ${meta.windowId}: entryPrice not recorded — PnL and drawdown scores will be zeroed`);
  }
  const entryPrice = meta.entryPrice ?? outcomePrice;
  // Price samples during horizon — for hackathon, use only entry + outcome
  // Production: collect price samples from Deepbook throughout the horizon
  const priceSamples = [entryPrice, outcomePrice];

  const scores  = computeScores(record.prediction, entryPrice, outcomePrice, priceSamples);
  const scaled  = scaleForChain(scores);

  // Upload prediction JSON to IPFS for auditability
  const revealRef = await uploadRevealData(record, scores, env);

  // Reveal on-chain: verify hash matches preimage
  const preimage = encodeForCommit(record.prediction);
  await txReveal(
    client, keypair, env,
    record.commitId,
    meta.windowId,
    preimage,
    revealRef,
  );

  // Store score record in KV so the dashboard can show results per window.
  // pnlUsd is the paper-trading PnL of the agent's order in dollars
  // (sizeUsdc and prices are 1e6-scaled, so the ratio leaves a 1e6-scaled USD value).
  const pnlUsd = computePnL(record.prediction, entryPrice, outcomePrice) / 1e6;
  await env.KV.put(
    KVKey.windowScore(meta.windowId, agentAddress),
    JSON.stringify({
      brierScore:   scores.brierScore,
      pnlNorm:      scores.pnlNorm,
      drawdown:     scores.drawdown,
      composite:    scores.composite,
      pnlUsd,
      entryPrice,
      outcomePrice,
      revealRef,
      revealedAt:   Date.now(),
    }),
  );

  // Record score on-chain
  const profileId = await env.KV.get(`agent:${agentAddress}:profile_id`);
  if (!profileId) {
    console.warn(`[resolve] no profile ID cached for agent ${agentAddress}`);
    return;
  }

  await txRecordScore(client, keypair, env, profileId, meta.windowId, scaled);

  console.log(
    `[resolve] agent ${agentAddress} scored: C=${scores.composite.toFixed(4)}`
    + ` brier=${scores.brierScore.toFixed(4)}`
    + ` pnl=${scores.pnlNorm.toFixed(4)}`
    + ` dd=${scores.drawdown.toFixed(4)}`
  );
}

// ── Walrus upload ─────────────────────────────────────────────────────────────

// Public Walrus testnet publisher — no auth, no wallet required
// Mainnet: https://publisher.walrus.space
const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_EPOCHS = 5;  // store for 5 epochs (~10 days on testnet)

/**
 * Upload prediction + scores JSON to Walrus decentralized storage.
 * Returns the blob ID which serves as the reveal_ref stored on-chain.
 * Blob is publicly readable via aggregator: GET /v1/blobs/<blob_id>
 */
async function uploadRevealData(
  record: CommitRecord,
  scores: ReturnType<typeof computeScores>,
  env:    Env,
): Promise<string> {
  const payload = JSON.stringify({
    windowId:     record.windowId,
    agentAddress: record.agentAddress,
    commitHash:   record.hash,
    prediction:   record.prediction,
    scores: {
      brierScore: scores.brierScore,
      pnlNorm:    scores.pnlNorm,
      drawdown:   scores.drawdown,
      composite:  scores.composite,
    },
    revealedAt: new Date().toISOString(),
    network:    env.SUI_NETWORK,
  });

  const res = await fetch(
    `${WALRUS_PUBLISHER}/v1/blobs?epochs=${WALRUS_EPOCHS}`,
    {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Walrus upload failed ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    newlyCreated?: { blobObject: { blobId: string } };
    alreadyCertified?: { blobId: string };
  };

  // Walrus returns either newlyCreated or alreadyCertified
  const blobId =
    data.newlyCreated?.blobObject?.blobId ??
    data.alreadyCertified?.blobId;

  if (!blobId) {
    throw new Error(`Walrus upload succeeded but no blob ID in response: ${JSON.stringify(data)}`);
  }

  console.log(`[resolve] uploaded to Walrus: ${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
  return blobId;
}
