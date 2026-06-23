/**
 * Sui client initialisation and PTB builders for every Veritas contract call.
 * One function per contract entry point — keeps handler code clean.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import type { Env, ScoreComponentsScaled } from '../types';

export type SuiClientType  = SuiClient;
export type SuiKeypairType = Ed25519Keypair;

// ── Client + keypair ──────────────────────────────────────────────────────────

export function buildClient(env: Env): SuiClient {
  const url = env.SUI_NETWORK === 'mainnet'
    ? getFullnodeUrl('mainnet')
    : getFullnodeUrl('testnet');
  return new SuiClient({ url });
}

export function buildKeypair(env: Env): Ed25519Keypair {
  const base64 = env.SUI_PRIVATE_KEY;
  const binary = atob(base64);
  const raw    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  return Ed25519Keypair.fromSecretKey(raw);
}

export async function signAndExecute(
  client:  SuiClient,
  keypair: Ed25519Keypair,
  tx:      Transaction,
  attempts = 5,
): Promise<string> {
  // fullnode.testnet.sui.io is load-balanced and nodes lag each other, which
  // produces "Could not find the referenced transaction" in two flavors:
  //   1. Before execution — the receiving node hasn't indexed the tx that last
  //      mutated our gas coin. The tx was not executed; resubmitting is safe.
  //   2. After execution — the tx landed on-chain but the reporting node can't
  //      find it yet, so the RPC call errors even though the tx SUCCEEDED.
  // We sign once (identical bytes are idempotent — no equivocation risk), and on
  // every error first check whether our digest actually landed before retrying.
  tx.setSenderIfNotSet(keypair.toSuiAddress());
  const bytes  = await tx.build({ client });
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const { signature } = await keypair.signTransaction(bytes);

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEffects: true, showObjectChanges: true },
      });
      if (result.effects?.status.status !== 'success') {
        throw new Error(`Tx failed: ${JSON.stringify(result.effects?.status)}`);
      }
      return result.digest;
    } catch (err) {
      const msg = String(err);
      try {
        const confirmed = await client.waitForTransaction({
          digest,
          options: { showEffects: true },
          timeout: 15_000,
        });
        if (confirmed.effects?.status.status === 'success') return digest;
      } catch {
        // not found on-chain — genuinely not executed, fall through to retry
      }
      const retryable =
        msg.includes('Could not find the referenced transaction') ||
        msg.includes('not available for consumption') ||
        msg.includes('Error checking transaction input objects');
      if (!retryable || i === attempts - 1) throw err;
      lastErr = err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Transaction builders ──────────────────────────────────────────────────────

/**
 * window::open(config, clock) → window ID + initial shared version
 * Opens a new prediction window. Returns the created Window object ID and its
 * initialSharedVersion so later transactions can reference it with
 * tx.sharedObjectRef() — bypassing fullnode object resolution, which fails
 * when the load-balanced RPC routes to a node that hasn't indexed this tx yet.
 */
export async function txOpenWindow(
  client:  SuiClient,
  keypair: Ed25519Keypair,
  env:     Env,
): Promise<{ windowId: string; initialSharedVersion: string; opensAt: number; closesAt: number; resolvesAt: number }> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::window::open`,
    arguments: [
      tx.object(env.MARKET_CONFIG_ID),
      tx.object('0x6'), // Sui clock object — always 0x6
    ],
  });
  const digest = await signAndExecute(client, keypair, tx);

  // waitForTransaction polls until the tx is indexed on the responding node,
  // then returns the response — avoids a separate getTransactionBlock that can
  // hit an unsynced node and 404.
  const result = await client.waitForTransaction({
    digest,
    options: { showObjectChanges: true, showEvents: true },
  });
  const created = result.objectChanges?.find(
    c => c.type === 'created' && c.objectType?.includes('::window::Window'),
  );
  if (!created || created.type !== 'created') {
    throw new Error('Window object not found in tx effects');
  }

  const owner = created.owner as { Shared?: { initial_shared_version: number | string } };
  if (!owner?.Shared) {
    throw new Error('Window object is not shared — cannot extract initialSharedVersion');
  }

  // Use the contract's own timing (emitted in WindowOpened) so the off-chain
  // phase schedule matches on-chain exactly. Computing it from KV config drifts:
  // the contract derives closes_at/resolves_at from MarketConfig, and a mismatch
  // makes the Worker call resolve() before the real horizon → E_HORIZON_NOT_ELAPSED.
  const opened = result.events?.find(e => e.type.includes('::window::WindowOpened'));
  const f = opened?.parsedJson as { opens_at: string; closes_at: string; resolves_at: string } | undefined;
  if (!f) {
    throw new Error('WindowOpened event not found — cannot determine on-chain timing');
  }

  return {
    windowId:             created.objectId,
    initialSharedVersion: String(owner.Shared.initial_shared_version),
    opensAt:    Number(f.opens_at),
    closesAt:   Number(f.closes_at),
    resolvesAt: Number(f.resolves_at),
  };
}

/**
 * Looks up a shared object's initial shared version via getObject.
 * Fallback for windows whose KV meta predates initialSharedVersion tracking.
 */
export async function getInitialSharedVersion(
  client:   SuiClient,
  objectId: string,
): Promise<string> {
  const res   = await client.getObject({ id: objectId, options: { showOwner: true } });
  const owner = res.data?.owner as { Shared?: { initial_shared_version: number | string } } | null;
  if (!owner?.Shared) {
    throw new Error(`Object ${objectId} is not a shared object (owner: ${JSON.stringify(owner)})`);
  }
  return String(owner.Shared.initial_shared_version);
}

/**
 * commit::commit(window, clock, hash) → commit ID
 * Submits a hashed prediction for an agent during deliberation.
 */
export async function txCommit(
  client:    SuiClient,
  keypair:   Ed25519Keypair,
  env:       Env,
  windowId:  string,
  hashBytes: Uint8Array,
  initialSharedVersion?: string,
): Promise<string> {
  // sharedObjectRef skips the fullnode's dynamic object resolution, which fails
  // with "Could not find the referenced transaction" when the load-balanced RPC
  // hits a node that hasn't indexed the window-creating tx yet.
  const sharedVersion = initialSharedVersion ?? await getInitialSharedVersion(client, windowId);
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::commit::commit`,
    arguments: [
      tx.sharedObjectRef({ objectId: windowId, initialSharedVersion: sharedVersion, mutable: true }),
      tx.object('0x6'),
      tx.pure.vector('u8', Array.from(hashBytes)),
    ],
  });
  const digest = await signAndExecute(client, keypair, tx);

  const result = await client.waitForTransaction({
    digest,
    options: { showObjectChanges: true },
  });
  const created = result.objectChanges?.find(
    c => c.type === 'created' && c.objectType?.includes('::commit::Commit'),
  );
  if (!created || created.type !== 'created') {
    throw new Error('Commit object not found in tx effects');
  }
  return created.objectId;
}

/**
 * window::resolve(window, clock, outcome_price)
 * Records outcome price on-chain. Called after horizon elapses.
 */
export async function txResolveWindow(
  client:       SuiClient,
  keypair:      Ed25519Keypair,
  env:          Env,
  windowId:     string,
  outcomePrice: number,   // scaled 1e6
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::window::resolve`,
    arguments: [
      tx.object(windowId),
      tx.object('0x6'),
      tx.pure.u64(BigInt(outcomePrice)),
    ],
  });
  return signAndExecute(client, keypair, tx);
}

/**
 * commit::reveal(commit, window, preimage, reveal_ref)
 * Reveals prediction after window resolves. Verifies hash on-chain.
 * reveal_ref is an IPFS CID or Walrus blob ID pointing to full prediction JSON.
 */
export async function txReveal(
  client:    SuiClient,
  keypair:   Ed25519Keypair,
  env:       Env,
  commitId:  string,
  windowId:  string,
  preimage:  Uint8Array,
  revealRef: string,       // IPFS CID or similar
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::commit::reveal`,
    arguments: [
      tx.object(commitId),
      tx.object(windowId),
      tx.pure.vector('u8', Array.from(preimage)),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(revealRef))),
    ],
  });
  return signAndExecute(client, keypair, tx);
}

/**
 * scoring::verify_and_build → agent_profile::record_score
 * Builds a validated ScoreBundle on-chain then records it on the profile.
 * Two PTB steps: verify_and_build validates composite formula; record_score
 * updates rolling score, history, and tier.
 *
 * Profile must be owned by the Worker keypair (Worker calls this as the owner).
 */
export async function txRecordScore(
  client:    SuiClient,
  keypair:   Ed25519Keypair,
  env:       Env,
  profileId: string,
  windowId:  string,
  scores:    ScoreComponentsScaled,
): Promise<string> {
  const tx = new Transaction();

  const bundle = tx.moveCall({
    target:    `${env.PACKAGE_ID}::scoring::verify_and_build`,
    arguments: [
      tx.object(env.MARKET_CONFIG_ID),
      tx.pure.u64(BigInt(scores.brierScore)),
      tx.pure.u64(BigInt(scores.pnlNorm)),
      tx.pure.u64(BigInt(scores.drawdown)),
      tx.pure.u64(BigInt(scores.composite)),
    ],
  });

  tx.moveCall({
    target:    `${env.PACKAGE_ID}::agent_profile::record_score`,
    arguments: [
      tx.object(profileId),
      tx.object(env.MARKET_CONFIG_ID),
      tx.pure.id(windowId),
      bundle,
    ],
  });

  return signAndExecute(client, keypair, tx);
}

/**
 * agent_profile::record_miss(profile, config)
 * Increments missed window count and applies decay if past threshold.
 */
export async function txRecordMiss(
  client:    SuiClient,
  keypair:   Ed25519Keypair,
  env:       Env,
  profileId: string,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::agent_profile::record_miss`,
    arguments: [
      tx.object(profileId),
      tx.object(env.MARKET_CONFIG_ID),
    ],
  });
  return signAndExecute(client, keypair, tx);
}

/**
 * policy::update_tier(admin_cap, policy, new_tier)
 * Updates agent's PolicyObject capability when tier changes.
 */
export async function txUpdateTier(
  client:    SuiClient,
  keypair:   Ed25519Keypair,
  env:       Env,
  adminCapId: string,
  policyId:   string,
  newTier:    number,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::policy::update_tier`,
    arguments: [
      tx.object(adminCapId),
      tx.object(policyId),
      tx.pure.u8(newTier),
    ],
  });
  return signAndExecute(client, keypair, tx);
}

/**
 * agent_profile::create(ctx) → profile ID
 * Creates a new AgentProfile. Called by Worker on first login.
 *
 * KNOWN LIMITATION: The Move contract uses ctx.sender() as the profile owner,
 * so all profiles are currently owned by the Worker keypair, not the user's
 * zkLogin address. agentAddress is passed here for call-site clarity but cannot
 * be forwarded until the contract is updated to accept it as an explicit parameter.
 * The KV mapping (agent:<agentAddress>:profile_id) is what ties a user to their
 * profile for all Worker operations.
 *
 * Production fix: update Move contract to accept zk_identity: address as arg,
 * or have the user submit this tx themselves with their zkLogin signature.
 */
export async function txCreateProfile(
  client:        SuiClient,
  keypair:       Ed25519Keypair,
  env:           Env,
  _agentAddress: string,   // zkLogin-derived address — cannot yet be used in Move call
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::agent_profile::create`,
    arguments: [],
  });

  const digest = await signAndExecute(client, keypair, tx);

  // Extract created AgentProfile object ID from effects
  const result = await client.waitForTransaction({
    digest,
    options: { showObjectChanges: true },
  });
  const created = result.objectChanges?.find(
    c => c.type === 'created' && c.objectType?.includes('::agent_profile::AgentProfile'),
  );
  if (!created || created.type !== 'created') {
    throw new Error('AgentProfile object not found in tx effects');
  }
  return created.objectId;
}

/**
 * market_config::update_timing(admin_cap, config, deliberation_secs, horizon_secs, window_interval_secs)
 * Updates window timing parameters. Requires AdminCap.
 */
export async function txUpdateTiming(
  client:              SuiClient,
  keypair:             Ed25519Keypair,
  env:                 Env,
  adminCapId:          string,
  deliberationSecs:    bigint,
  horizonSecs:         bigint,
  windowIntervalSecs:  bigint,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::market_config::update_timing`,
    arguments: [
      tx.object(adminCapId),
      tx.object(env.MARKET_CONFIG_ID),
      tx.pure.u64(deliberationSecs),
      tx.pure.u64(horizonSecs),
      tx.pure.u64(windowIntervalSecs),
    ],
  });
  return signAndExecute(client, keypair, tx);
}
/**
 * registry::distribute_revenue(admin_cap, registry, agent, window_id, proceeds)
 * Splits `rewardMist` from the Worker's gas coin as the window's proceeds:
 * 80% is paid to the agent immediately, the remaining 20% accrues into each
 * delegator's on-chain `claimable` balance (pull model — delegators call
 * registry::claim themselves). Requires the AdminCap held by the Worker.
 */
export async function txDistributeRevenue(
  client:     SuiClient,
  keypair:    Ed25519Keypair,
  env:        Env,
  agent:      string,
  windowId:   string,
  rewardMist: bigint,
): Promise<string> {
  const tx = new Transaction();
  const [proceeds] = tx.splitCoins(tx.gas, [rewardMist]);
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::registry::distribute_revenue`,
    arguments: [
      tx.object(env.ADMIN_CAP_ID),
      tx.object(env.REGISTRY_ID),
      tx.pure.address(agent),
      tx.pure.id(windowId),
      proceeds,
    ],
  });
  return signAndExecute(client, keypair, tx);
}

/**
 * Read a delegated agent's total staked principal (MIST) via a read-only
 * devInspect of registry::total_stake. Returns 0 if the agent has no entry or
 * no delegators. Cheap (no gas, one RPC) — used to skip distribution for agents
 * nobody has staked behind.
 */
export async function readTotalStake(
  client: SuiClient,
  env:    Env,
  agent:  string,
): Promise<bigint> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target:    `${env.PACKAGE_ID}::registry::total_stake`,
      arguments: [tx.object(env.REGISTRY_ID), tx.pure.address(agent)],
    });
    const res = await client.devInspectTransactionBlock({
      sender: agent,
      transactionBlock: tx,
    });
    const ret = res.results?.[0]?.returnValues?.[0];
    if (!ret) return 0n;
    const bytes = Uint8Array.from(ret[0]);
    // u64 little-endian
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  } catch {
    return 0n;
  }
}
