/**
 * Sui client initialisation and PTB builders for every Veritas contract call.
 * One function per contract entry point — keeps handler code clean.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction }               from '@mysten/sui/transactions';
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
): Promise<string> {
  const result = await client.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options:     { showEffects: true, showObjectChanges: true },
  });
  if (result.effects?.status.status !== 'success') {
    throw new Error(`Tx failed: ${JSON.stringify(result.effects?.status)}`);
  }
  return result.digest;
}

// ── Transaction builders ──────────────────────────────────────────────────────

/**
 * window::open(config, clock) → window ID
 * Opens a new prediction window. Returns the created Window object ID.
 */
export async function txOpenWindow(
  client:  SuiClient,
  keypair: Ed25519Keypair,
  env:     Env,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::window::open`,
    arguments: [
      tx.object(env.MARKET_CONFIG_ID),
      tx.object('0x6'), // Sui clock object — always 0x6
    ],
  });
  const digest = await signAndExecute(client, keypair, tx);

  // Wait for RPC to index the transaction
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Extract created Window object ID from effects
  const result = await client.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const created = result.objectChanges?.find(
    c => c.type === 'created' && c.objectType?.includes('::window::Window'),
  );
  if (!created || created.type !== 'created') {
    throw new Error('Window object not found in tx effects');
  }
  return created.objectId;
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
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target:    `${env.PACKAGE_ID}::commit::commit`,
    arguments: [
      tx.object(windowId),
      tx.object('0x6'),
      tx.pure.vector('u8', Array.from(hashBytes)),
    ],
  });
  const digest = await signAndExecute(client, keypair, tx);

  const result = await client.getTransactionBlock({
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
  const result = await client.getTransactionBlock({
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