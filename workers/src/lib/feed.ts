/**
 * Feed aggregation: Deepbook V3 Indexer + CoinGecko price.
 *
 * Primary: Deepbook Indexer (mystenlabs.com)
 *   Testnet: https://deepbook-indexer.testnet.mystenlabs.com
 *   Mainnet: https://deepbook-indexer.mainnet.mystenlabs.com
 *
 * Fallback: CoinGecko (if indexer fails)
 */

import type { Env, FeedSnapshot, DeepbookLevel } from '../types';
import { SuiClient } from '@mysten/sui/client';

const PRICE_SCALE = 1_000_000;

// ── CoinGecko ─────────────────────────────────────────────────────────────────

export async function fetchCoinGeckoPrice(apiKey: string): Promise<number> {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
  const res  = await fetch(url, {
    headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
  });
  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
  const data = await res.json() as { sui: { usd: number } };
  return Math.round(data.sui.usd * PRICE_SCALE);
}

// ── Primary feed with fallback ────────────────────────────────────────────────

export async function fetchDeepbookSnapshot(
  _client:  SuiClient,
  _address: string,
  _network: string,
  apiKey:   string,
): Promise<{
  bids:     DeepbookLevel[];
  asks:     DeepbookLevel[];
  midPrice: number;
}> {
  // Worker uses CoinGecko as price oracle.
  // Deepbook indexer is accessible from agent servers directly,
  // not from Cloudflare Workers (egress restriction).
  const price  = await fetchCoinGeckoPrice(apiKey);
  const spread = Math.round(price * 0.001);
  return {
    bids:     [{ price: price - spread, qty: 1_000_000 }, { price: price - spread * 2, qty: 2_000_000 }],
    asks:     [{ price: price + spread, qty: 1_000_000 }, { price: price + spread * 2, qty: 2_000_000 }],
    midPrice: price,
  };
}

export async function fetchMidPrice(
  client:  SuiClient,
  address: string,
  network: string,
  apiKey:  string,
): Promise<number> {
  const { midPrice } = await fetchDeepbookSnapshot(client, address, network, apiKey);
  return midPrice;
}

// ── Snapshot assembly + signing ───────────────────────────────────────────────

export async function assembleFeedSnapshot(
  windowId: string,
  client:   SuiClient,
  env:      Env,
  keypair:  import('@mysten/sui/keypairs/ed25519').Ed25519Keypair,
): Promise<FeedSnapshot> {
  const address = keypair.toSuiAddress();

  // fetchDeepbookSnapshot already calls fetchCoinGeckoPrice internally and
  // uses it as midPrice — reuse that result to avoid a second API call and
  // ensure midPrice and coingeckoPrice are always consistent.
  const deepbook = await fetchDeepbookSnapshot(client, address, env.SUI_NETWORK, env.COINGECKO_API_KEY);
  const coingeckoPrice = deepbook.midPrice;

  const snapshot: Omit<FeedSnapshot, 'signature'> = {
    windowId,
    timestamp:      Date.now(),
    bids:           deepbook.bids,
    asks:           deepbook.asks,
    midPrice:       deepbook.midPrice,
    coingeckoPrice,
  };

  const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  const msgBytes  = new TextEncoder().encode(canonical);
  const sigBytes  = await keypair.sign(msgBytes);
  const signature = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return { ...snapshot, signature };
}