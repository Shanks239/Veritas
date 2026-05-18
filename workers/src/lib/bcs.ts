/**
 * Canonical BCS serialization for commit hashing.
 *
 * The hash committed on-chain is:
 *   blake2b256(bcs_encode(Prediction))
 *
 * Move structs mirrored here:
 *   struct PriceBucket   { bucket_low: u64, bucket_high: u64, probability: u64 }
 *   struct PredictionOrder { side: u8, size_usdc: u64, limit_price: u64 }
 *   struct Prediction    { distribution: vector<PriceBucket>, order: PredictionOrder }
 *
 * Probabilities scaled by 1_000_000 (float → u64).
 * Prices scaled by 1_000_000.
 */

import { blake2b } from '@noble/hashes/blake2b';
import type { AgentPrediction, PriceBucket, PredictionOrder } from '../types';

const PROB_SCALE  = 1_000_000n;
const PRICE_SCALE = 1_000_000n;

// ── BCS primitives ────────────────────────────────────────────────────────────

function u64LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

function ulebLength(n: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>= 7;
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ── Struct encoders ───────────────────────────────────────────────────────────

function encodeBucket(b: PriceBucket): Uint8Array {
  return concat(
    u64LE(BigInt(Math.round(b.bucketLow   * Number(PRICE_SCALE)))),
    u64LE(BigInt(Math.round(b.bucketHigh  * Number(PRICE_SCALE)))),
    u64LE(BigInt(Math.round(b.probability * Number(PROB_SCALE)))),
  );
}

function encodeOrder(o: PredictionOrder): Uint8Array {
  return concat(
    u8(o.side === 'bid' ? 0 : 1),
    u64LE(BigInt(Math.round(o.sizeUsdc   * Number(PRICE_SCALE)))),
    u64LE(BigInt(Math.round(o.limitPrice * Number(PRICE_SCALE)))),
  );
}

function encodePrediction(p: AgentPrediction): Uint8Array {
  const bucketBytes = p.distribution.map(encodeBucket);
  return concat(ulebLength(bucketBytes.length), ...bucketBytes, encodeOrder(p.order));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function encodeForCommit(prediction: AgentPrediction): Uint8Array {
  return encodePrediction(prediction);
}

export function hashPrediction(prediction: AgentPrediction): string {
  return Buffer.from(blake2b(encodePrediction(prediction), { dkLen: 32 })).toString('hex');
}

export function hashPredictionBytes(prediction: AgentPrediction): Uint8Array {
  return blake2b(encodePrediction(prediction), { dkLen: 32 });
}
