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
} from '../types';

// ── Main export ───────────────────────────────────────────────────────────────

export async function resolveAndScore(
  meta:    WindowMeta,
  client:  SuiClientType,
  keypair: SuiKeypairType,
  env:     Env,
): Promise<void> {
  // 1. Fetch outcome price
  const address      = keypair.toSuiAddress();
  const outcomePrice = await fetchMidPrice(client, address, env.SUI_NETWORK, env.COINGECKO_API_KEY);

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
