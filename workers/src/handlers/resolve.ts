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
} from '../lib/sui';
import { fetchMidPrice }          from '../lib/feed';
import { computeScores, scaleForChain } from '../lib/scoring';
import { encodeForCommit }        from '../lib/bcs';
import {
  KV as KVKey,
  type Env,
  type WindowMeta,
  type CommitRecord,
  type AgentPrediction,
} from '../types';

// ── Main export ───────────────────────────────────────────────────────────────

export async function resolveAndScore(
  meta:    WindowMeta,
  client:  ReturnType<import('../lib/sui').buildClient>,
  keypair: ReturnType<import('../lib/sui').buildKeypair>,
  env:     Env,
): Promise<void> {
  // 1. Fetch outcome price
  const outcomePrice = await fetchMidPrice(client);

  // 2. Resolve window on-chain
  await txResolveWindow(client, keypair, env, meta.windowId, outcomePrice);
  console.log(`[resolve] window ${meta.windowId} resolved at price ${outcomePrice}`);

  // 3. Score all committed agents
  const agentsRaw = await env.KV.get(KVKey.windowAgents(meta.windowId));
  const agents: string[] = agentsRaw ? JSON.parse(agentsRaw) : [];

  await Promise.allSettled(
    agents.map(agent =>
      scoreAgent(agent, meta, outcomePrice, client, keypair, env)
    ),
  );
}

// ── Per-agent scoring ─────────────────────────────────────────────────────────

async function scoreAgent(
  agentAddress: string,
  meta:         WindowMeta,
  outcomePrice: number,
  client:       ReturnType<import('../lib/sui').buildClient>,
  keypair:      ReturnType<import('../lib/sui').buildKeypair>,
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
  const entryPrice = meta.entryPrice ?? outcomePrice; // fallback if not stored
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

// ── IPFS / Walrus upload ──────────────────────────────────────────────────────

/**
 * Upload the full prediction + scores JSON for public auditability.
 * Returns a content identifier (IPFS CID or Walrus blob ID).
 *
 * Hackathon: stub that returns a deterministic identifier from the commit hash.
 * Production: upload to IPFS via Pinata/web3.storage, or Walrus on Sui.
 */
async function uploadRevealData(
  record: CommitRecord,
  scores: ReturnType<typeof computeScores>,
  env:    Env,
): Promise<string> {
  const payload = {
    windowId:     record.windowId,
    agentAddress: record.agentAddress,
    prediction:   record.prediction,
    scores,
    revealedAt:   Date.now(),
  };

  // TODO: replace with real IPFS/Walrus upload
  // const cid = await pinataUpload(JSON.stringify(payload), env.PINATA_JWT)
  // return cid

  // Stub: use commit hash as placeholder CID
  const cid = `veritas-reveal-${record.hash.slice(0, 16)}`;
  console.log(`[resolve] reveal data stub CID: ${cid}`);
  return cid;
}
