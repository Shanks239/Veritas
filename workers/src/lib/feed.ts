/**
 * Feed aggregation: Deepbook V3 orderbook snapshot + CoinGecko price.
 *
 * Uses @mysten/deepbook-v3 SDK methods:
 *   - midPrice(poolKey)          → current mid-price
 *   - getLevel2TicksFromMid()    → bid/ask depth around mid
 */

import { DeepBookClient } from '@mysten/deepbook-v3';
import { SuiClient }      from '@mysten/sui/client';
import type { Env, FeedSnapshot, DeepbookLevel } from '../types';

const PRICE_SCALE = 1_000_000;
const POOL_KEY    = 'SUI_USDC';  // built-in key in SDK constants
const DEPTH_TICKS = 10;          // N ticks each side from mid

// ── Deepbook ──────────────────────────────────────────────────────────────────

function buildDeepBookClient(
  client:  SuiClient,
  address: string,
  env:     string,
): DeepBookClient {
  return new DeepBookClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client:  client as any,   // SDK uses internal SuiClient type — cast is safe
    address,
    env:    env === 'mainnet' ? 'mainnet' : 'testnet',
  });
}

/**
 * Fetch orderbook depth and mid-price from Deepbook V3 SUI/USDC pool.
 */
export async function fetchDeepbookSnapshot(
  client:  SuiClient,
  address: string,
  env:     string,
): Promise<{
  bids:     DeepbookLevel[];
  asks:     DeepbookLevel[];
  midPrice: number;
}> {
  const dbClient = buildDeepBookClient(client, address, env);

  // Fetch mid-price and depth in parallel
  const [mid, depth] = await Promise.all([
    dbClient.midPrice(POOL_KEY),
    dbClient.getLevel2TicksFromMid(POOL_KEY, DEPTH_TICKS),
  ]);

  // Convert parallel price/qty arrays to DeepbookLevel[]
  const bids: DeepbookLevel[] = depth.bid_prices.map((price, i) => ({
    price: Math.round(price    * PRICE_SCALE),
    qty:   Math.round((depth.bid_quantities[i] ?? 0) * PRICE_SCALE),
  })).sort((a, b) => b.price - a.price);  // highest bid first

  const asks: DeepbookLevel[] = depth.ask_prices.map((price, i) => ({
    price: Math.round(price    * PRICE_SCALE),
    qty:   Math.round((depth.ask_quantities[i] ?? 0) * PRICE_SCALE),
  })).sort((a, b) => a.price - b.price);  // lowest ask first

  const midPrice = Math.round(mid * PRICE_SCALE);

  return { bids, asks, midPrice };
}

/**
 * Read Deepbook mid-price only.
 * Used for entry price at window close and outcome price at horizon.
 */
export async function fetchMidPrice(
  client:  SuiClient,
  address: string,
  env:     string,
): Promise<number> {
  const dbClient = buildDeepBookClient(client, address, env);
  const mid      = await dbClient.midPrice(POOL_KEY);
  return Math.round(mid * PRICE_SCALE);
}

// ── CoinGecko ─────────────────────────────────────────────────────────────────

export async function fetchCoinGeckoPrice(apiKey: string): Promise<number> {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';

  const res = await fetch(url, {
    headers: { 'x-cg-demo-api-key': apiKey },
  });

  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);

  const data = await res.json() as { sui: { usd: number } };
  return Math.round(data.sui.usd * PRICE_SCALE);
}

// ── Snapshot assembly + signing ───────────────────────────────────────────────

export async function assembleFeedSnapshot(
  windowId: string,
  client:   SuiClient,
  env:      Env,
  keypair:  import('@mysten/sui/keypairs/ed25519').Ed25519Keypair,
): Promise<FeedSnapshot> {
  const address = keypair.toSuiAddress();

  const [deepbook, coingeckoPrice] = await Promise.all([
    fetchDeepbookSnapshot(client, address, env.SUI_NETWORK),
    fetchCoinGeckoPrice(env.COINGECKO_API_KEY),
  ]);

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
