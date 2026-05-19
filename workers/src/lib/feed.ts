/**
 * Feed aggregation: Deepbook orderbook snapshot + CoinGecko price.
 * Worker signs the feed so agents can verify data provenance.
 */

import { SuiClient } from '@mysten/sui/client';
import type { Env, FeedSnapshot, DeepbookLevel } from '../types';

// Deepbook V3 pool ID for SUI/USDC on testnet — replace with mainnet ID for prod
const DEEPBOOK_POOL_SUI_USDC = '0xTODO_DEEPBOOK_POOL_ID';
const PRICE_SCALE             = 1_000_000;

// ── Deepbook ──────────────────────────────────────────────────────────────────

/**
 * Read orderbook depth from Deepbook V3.
 * Returns top 10 levels on each side, prices scaled by PRICE_SCALE.
 */
export async function fetchDeepbookSnapshot(client: SuiClient): Promise<{
  bids:     DeepbookLevel[];
  asks:     DeepbookLevel[];
  midPrice: number;
}> {
  // Deepbook V3 exposes orderbook via devInspect on the pool object.
  // For the hackathon we query the pool's bids/asks tables directly.
  // Production: use the Deepbook SDK's getOrderBook method.
  await client.getObject({
    id:      DEEPBOOK_POOL_SUI_USDC,
    options: { showContent: true },
  });

  // TODO: parse Deepbook pool content into bids/asks levels
  // Placeholder implementation — replace with real Deepbook SDK call
  const bids: DeepbookLevel[] = [];
  const asks: DeepbookLevel[] = [];

  // Real implementation would look like:
  // const { bids, asks } = await deepbookClient.getOrderBook(POOL_ID, 10)

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = bestBid > 0 && bestAsk > 0
    ? Math.round((bestBid + bestAsk) / 2)
    : 0;

  return { bids, asks, midPrice };
}

/**
 * Read Deepbook mid-price only (used for entry price at window close
 * and outcome price at horizon).
 */
export async function fetchMidPrice(client: SuiClient): Promise<number> {
  const { midPrice } = await fetchDeepbookSnapshot(client);
  return midPrice;
}

// ── CoinGecko ─────────────────────────────────────────────────────────────────

export async function fetchCoinGeckoPrice(apiKey: string): Promise<number> {
  const url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=sui&vs_currencies=usd';

  const res = await fetch(url, {
    headers: { 'x-cg-demo-api-key': apiKey },
  });

  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);

  const data = await res.json() as { sui: { usd: number } };
  return Math.round(data.sui.usd * PRICE_SCALE);
}

// ── Snapshot assembly + signing ───────────────────────────────────────────────

/**
 * Assemble a complete feed snapshot for a window.
 * Signs the canonical JSON with the Worker's Ed25519 keypair.
 */
export async function assembleFeedSnapshot(
  windowId:  string,
  client:    SuiClient,
  env:       Env,
  keypair:   import('@mysten/sui/keypairs/ed25519').Ed25519Keypair,
): Promise<FeedSnapshot> {
  const [deepbook, coingeckoPrice] = await Promise.all([
    fetchDeepbookSnapshot(client),
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

  // Sign canonical JSON (sorted keys, deterministic)
  const canonical  = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  const msgBytes   = new TextEncoder().encode(canonical);
  const sigBytes   = await keypair.sign(msgBytes);
  const signature  = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return { ...snapshot, signature };
}
