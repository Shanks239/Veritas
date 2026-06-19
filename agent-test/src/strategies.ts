/**
 * Prediction strategies for Veritas agents.
 *
 * Each strategy is a pure function of the Worker payload that returns a
 * probability distribution over future price + a conviction-sized order.
 * All prices are 1e6-scaled (same convention as the Worker / contracts).
 *
 * A valid prediction must:
 *   - have distribution probabilities summing to 1.0 (±0.01)
 *   - have all probabilities >= 0
 *   - have order.sizeUsdc > 0
 *
 * The Worker hashes (windowId, agentAddress, distribution, order) in BCS and
 * commits the hash on-chain, so the *shape* below must stay stable.
 */

const USDC = 1_000_000;

export interface DeepbookLevel {
  price: number; // 1e6-scaled
  qty:   number; // 1e6-scaled
}

export interface WorkerPayload {
  window_id:   string;
  opens_at:    number;
  closes_at:   number;
  resolves_at: number;
  snapshot: {
    bids:      DeepbookLevel[];
    asks:      DeepbookLevel[];
    mid_price: number;
  };
  feeds: {
    coingecko_sui_usd: number;
    timestamp:         number;
  };
}

export interface PriceBucket {
  bucketLow:   number; // 1e6-scaled
  bucketHigh:  number; // 1e6-scaled
  probability: number; // [0,1]
}

export interface PredictionOrder {
  side:       'bid' | 'ask';
  sizeUsdc:   number; // notional, 1e6-scaled
  limitPrice: number; // 1e6-scaled
}

export interface StrategyResult {
  distribution: PriceBucket[];
  order:        PredictionOrder;
}

export type StrategyFn = (p: WorkerPayload) => StrategyResult;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Mid reference: prefer CoinGecko, fall back to Deepbook mid, then 1.0. */
function refPrice(p: WorkerPayload): number {
  return p.feeds?.coingecko_sui_usd || p.snapshot?.mid_price || USDC;
}

/** Total resting quantity on one side of the book. */
function depth(levels: DeepbookLevel[] | undefined): number {
  if (!levels?.length) return 0;
  return levels.reduce((acc, l) => acc + (l.qty || 0), 0);
}

/**
 * Build a contiguous distribution of `weights.length` buckets, each `step`
 * wide, centered on `mid`. Weights are normalized to sum to exactly 1.0;
 * any rounding remainder is folded into the heaviest bucket so the on-chain
 * sum check always passes.
 */
function makeDistribution(mid: number, step: number, weights: number[]): PriceBucket[] {
  const n     = weights.length;
  const half  = Math.floor(n / 2);
  // Shift base by half a step so `mid` sits in the middle of the center bucket.
  const base  = Math.round(mid - (half + 0.5) * step);
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  const buckets: PriceBucket[] = weights.map((w, i) => ({
    bucketLow:   base + i * step,
    bucketHigh:  base + (i + 1) * step,
    probability: Math.round((w / total) * 1e4) / 1e4,
  }));

  // Fold rounding error into the heaviest bucket.
  const sum     = buckets.reduce((a, b) => a + b.probability, 0);
  const heavy   = buckets.reduce((m, b, i) => (b.probability > buckets[m].probability ? i : m), 0);
  buckets[heavy].probability = Math.round((buckets[heavy].probability + (1 - sum)) * 1e4) / 1e4;

  return buckets;
}

/**
 * Tilt a symmetric base weight profile by `skew` ∈ [-1, 1].
 * skew > 0 pushes mass toward higher buckets (bullish), skew < 0 toward lower.
 */
function tilt(base: number[], skew: number): number[] {
  const half = Math.floor(base.length / 2);
  return base.map((w, i) => Math.max(0.02, w * (1 + skew * ((i - half) / half) * 0.8)));
}

const clamp = (x: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x));

// Symmetric bell-ish base profile (5 buckets).
const BELL = [1, 2, 3, 2, 1];

// ── Strategies ────────────────────────────────────────────────────────────────

/**
 * Order-book imbalance: lean toward the heavier side of the resting book.
 * Heavy bids → upward pressure → bullish skew + buy; heavy asks → bearish.
 */
const imbalance: StrategyFn = (p) => {
  const mid     = refPrice(p);
  const step    = Math.max(1, Math.round(mid * 0.01));
  const bidQty  = depth(p.snapshot?.bids);
  const askQty  = depth(p.snapshot?.asks);
  const r       = bidQty + askQty > 0 ? bidQty / (bidQty + askQty) : 0.5; // [0,1]
  const skew    = clamp((r - 0.5) * 2);

  const distribution = makeDistribution(mid, step, tilt(BELL, skew));
  const side: 'bid' | 'ask' = skew >= 0 ? 'bid' : 'ask';
  const sizeUsdc   = Math.round((50 + Math.abs(skew) * 150) * USDC);
  const limitPrice = Math.round(side === 'bid' ? mid * 0.999 : mid * 1.001);

  return { distribution, order: { side, sizeUsdc, limitPrice } };
};

/**
 * Momentum: trade in the direction of CoinGecko-vs-Deepbook drift.
 * Spot leading the book upward → buy strength; downward → sell.
 */
const momentum: StrategyFn = (p) => {
  const cg    = p.feeds?.coingecko_sui_usd || 0;
  const mid   = p.snapshot?.mid_price || cg || USDC;
  const ref   = cg || mid;
  const step  = Math.max(1, Math.round(ref * 0.01));
  const drift = mid > 0 ? (ref - mid) / mid : 0;
  const skew  = clamp(drift * 50);

  const distribution = makeDistribution(ref, step, tilt(BELL, skew));
  const side: 'bid' | 'ask' = skew >= 0 ? 'bid' : 'ask';
  const sizeUsdc   = Math.round((50 + Math.abs(skew) * 200) * USDC);
  // Chase the move: bid above mid / ask below mid to improve fill odds.
  const limitPrice = Math.round(side === 'bid' ? ref * 1.001 : ref * 0.999);

  return { distribution, order: { side, sizeUsdc, limitPrice } };
};

/**
 * Mean-reversion: fade the drift, betting price returns toward the book mid.
 * Spot above the book → expect pullback → sell; below → expect bounce → buy.
 */
const reversion: StrategyFn = (p) => {
  const cg    = p.feeds?.coingecko_sui_usd || 0;
  const mid   = p.snapshot?.mid_price || cg || USDC;
  const ref   = cg || mid;
  const step  = Math.max(1, Math.round(mid * 0.01));
  const drift = mid > 0 ? (ref - mid) / mid : 0;
  const skew  = clamp(-drift * 50); // opposite sign of momentum

  // Center the distribution on the book mid (the reversion target), not spot.
  const distribution = makeDistribution(mid, step, tilt(BELL, skew));
  const side: 'bid' | 'ask' = skew >= 0 ? 'bid' : 'ask';
  const sizeUsdc   = Math.round((40 + Math.abs(skew) * 150) * USDC);
  const limitPrice = Math.round(side === 'bid' ? mid * 0.998 : mid * 1.002);

  return { distribution, order: { side, sizeUsdc, limitPrice } };
};

/**
 * Conservative / wide: low-conviction baseline. Spreads probability mass
 * broadly around mid with a small fixed order. Low variance, low expected PnL.
 */
const wide: StrategyFn = (p) => {
  const mid  = refPrice(p);
  const step = Math.max(1, Math.round(mid * 0.012));

  const distribution = makeDistribution(mid, step, [2, 3, 3, 3, 2]);
  return {
    distribution,
    order: { side: 'bid', sizeUsdc: 25 * USDC, limitPrice: Math.round(mid * 0.99) },
  };
};

/**
 * Baseline: the original naive agent — 80% mass in a ±2% band, 20% above,
 * fixed 100 USDC bid. Kept so the legacy single-agent server is unchanged.
 */
const baseline: StrategyFn = (p) => {
  const mid = refPrice(p);
  return {
    distribution: [
      { bucketLow: Math.round(mid * 0.98), bucketHigh: Math.round(mid * 1.02), probability: 0.80 },
      { bucketLow: Math.round(mid * 1.02), bucketHigh: Math.round(mid * 1.04), probability: 0.20 },
    ],
    order: { side: 'bid', sizeUsdc: 100 * USDC, limitPrice: Math.round(mid * 0.99) },
  };
};

export const STRATEGIES: Record<string, StrategyFn> = {
  imbalance,
  momentum,
  reversion,
  wide,
  baseline,
};

export type StrategyName = keyof typeof STRATEGIES;

export function getStrategy(name: string | undefined): StrategyFn {
  return STRATEGIES[name ?? 'baseline'] ?? baseline;
}
