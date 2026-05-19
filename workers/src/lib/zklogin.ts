/**
 * zkLogin utilities for the Veritas Worker.
 *
 * Responsibilities:
 *   1. Salt management — deterministic salt derived from JWT sub + secret
 *   2. Address derivation — compute Sui address from JWT + salt
 *   3. Profile registration — create AgentProfile on-chain on first login
 *
 * The full zkLogin flow is split:
 *   Frontend (React): ephemeral keypair, OAuth redirect, ZK proof, tx signing
 *   Worker (here):    salt service, address derivation, profile creation
 *
 * Prover used: https://prover.mystenlabs.com/v1 (Mysten public testnet prover)
 */

import { jwtToAddress, decodeJwt } from '@mysten/sui/zklogin';
import type { Env } from '../types';

// Mysten Labs public prover — suitable for testnet/devnet
export const PROVER_URL = 'https://prover.mystenlabs.com/v1';

// ── Salt management ───────────────────────────────────────────────────────────

/**
 * Derive a deterministic salt for a user from their JWT sub claim.
 * Salt = HMAC-SHA256(sub, SALT_SECRET) truncated to u256.
 *
 * The salt must be consistent across sessions — changing it changes the address.
 * Store it in KV keyed by sub so we can retrieve it on future logins.
 *
 * SALT_SECRET is a Worker secret — set via: wrangler secret put SALT_SECRET
 */
export async function getOrCreateSalt(
  sub:    string,   // JWT subject claim — stable per user per provider
  env:    Env,
): Promise<string> {
  const kvKey = `salt:${sub}`;

  // Return existing salt if we've seen this user before
  const existing = await env.KV.get(kvKey);
  if (existing) return existing;

  // Derive a new salt: HMAC-SHA256(sub, SALT_SECRET)
  const secretKey  = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SALT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer  = await crypto.subtle.sign(
    'HMAC',
    secretKey,
    new TextEncoder().encode(sub),
  );

  // Convert to a large decimal string (u256-compatible)
  const bytes  = new Uint8Array(sigBuffer);
  let   saltBn = 0n;
  for (const byte of bytes) {
    saltBn = (saltBn << 8n) | BigInt(byte);
  }
  // Truncate to fit within BN254 field (used by zkLogin)
  const salt = (saltBn % (2n ** 128n)).toString();

  await env.KV.put(kvKey, salt);
  return salt;
}

// ── Address derivation ────────────────────────────────────────────────────────

/**
 * Derive the Sui address for a user from their JWT and salt.
 * Uses jwtToAddress from @mysten/sui/zklogin.
 */
export function deriveAddress(jwt: string, salt: string): string {
  return jwtToAddress(jwt, salt);
}

/**
 * Decode JWT claims without verification.
 * Full JWT verification happens on-chain via the ZK proof.
 * Worker only needs sub and iss for salt derivation.
 */
export function decodeJwtClaims(jwt: string): {
  sub: string;
  iss: string;
  aud: string | string[];
  email?: string;
} {
  const decoded = decodeJwt(jwt) as Record<string, unknown>;
  const sub = decoded['sub'] as string | undefined;
  const iss = decoded['iss'] as string | undefined;
  if (!sub || !iss) {
    throw new Error('JWT missing required claims: sub, iss');
  }
  return {
    sub,
    iss,
    aud:   decoded['aud'] as string | string[],
    email: decoded['email'] as string | undefined,
  };
}

// ── Nonce construction (returned to frontend) ─────────────────────────────────

/**
 * The Worker provides the current epoch to the frontend so it can construct
 * the OAuth nonce. The frontend combines epoch + ephemeral public key + randomness.
 *
 * Returns the data the frontend needs to build the OAuth URL.
 */
export async function getLoginParams(
  client: import('@mysten/sui/client').SuiClient,
): Promise<{
  epoch:    number;
  maxEpoch: number;
}> {
  const { epoch } = await client.getLatestSuiSystemState();
  const currentEpoch = Number(epoch);
  return {
    epoch:    currentEpoch,
    maxEpoch: currentEpoch + 2,   // ephemeral key valid for 2 epochs
  };
}
