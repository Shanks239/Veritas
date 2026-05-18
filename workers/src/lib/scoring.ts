/**
 * Off-chain score computation.
 * Produces ScoreComponents that are submitted on-chain alongside the reveal.
 * The Move contract verifies the composite formula — see scoring.move.
 *
 * All exported values are in [0, 1]. Scale to [0, 10_000] before on-chain submission.
 */

import type {
  AgentPrediction,
  ScoreComponents,
  ScoreComponentsScaled,
} from '../types';

const SCALE = 10_000;

// ── Brier score ───────────────────────────────────────────────────────────────

/**
 * Proper Brier score over a discrete distribution.
 * Brier = sum_i (p_i - o_i)^2  where o_i = 1 for the outcome bucket, else 0.
 * Normalized to [0, 1]: worst case is Brier = 2 (all prob in wrong bucket).
 * We invert so 1 = perfect, 0 = worst.
 */
export function brierScoreNormalized(
  prediction:   AgentPrediction,
  outcomePrice: number,   // scaled 1e6
): number {
  let raw = 0;

  for (const bucket of prediction.distribution) {
    const inBucket = outcomePrice >= bucket.bucketLow && outcomePrice < bucket.bucketHigh;
    const o        = inBucket ? 1 : 0;
    raw += (bucket.probability - o) ** 2;
  }

  // Brier ∈ [0, 2]; normalize then invert
  return 1 - raw / 2;
}

// ── PnL normalization ─────────────────────────────────────────────────────────

/**
 * Compute notional PnL for the agent's submitted order.
 * Paper trading: entry price at window close, exit at outcome price.
 *
 * PnL = sizeUsdc * (exitPrice - entryPrice) / entryPrice  for bids (long)
 *     = sizeUsdc * (entryPrice - exitPrice) / entryPrice  for asks (short)
 *
 * Returns PnL in USDC terms.
 */
export function computePnL(
  prediction:  AgentPrediction,
  entryPrice:  number,   // Deepbook mid at window close, scaled 1e6
  outcomePrice: number,  // Deepbook mid at horizon, scaled 1e6
): number {
  const { order } = prediction;
  const priceDelta = outcomePrice - entryPrice;
  const direction  = order.side === 'bid' ? 1 : -1;
  return (order.sizeUsdc * direction * priceDelta) / entryPrice;
}

/**
 * sigmoid(x) = 1 / (1 + e^-x)
 * Applied to PnL / position_size.
 * Naturally saturates at ±5x → [0.007, 0.993].
 */
export function pnlNormalized(pnl: number, positionSize: number): number {
  if (positionSize === 0) return 0.5;
  const x = pnl / positionSize;
  return 1 / (1 + Math.exp(-x));
}

// ── Drawdown ──────────────────────────────────────────────────────────────────

/**
 * Max adverse excursion (MAE) normalized by position size.
 * Requires price samples during the window horizon.
 *
 * For a bid (long): MAE = max(entryPrice - lowestPrice, 0)
 * For an ask (short): MAE = max(highestPrice - entryPrice, 0)
 *
 * Normalized: MAE / entryPrice, then capped at 1.
 */
export function drawdownNormalized(
  prediction:   AgentPrediction,
  entryPrice:   number,
  priceSamples: number[],   // prices observed during horizon, scaled 1e6
): number {
  if (priceSamples.length === 0) return 0;

  let mae: number;

  if (prediction.order.side === 'bid') {
    const lowest = Math.min(...priceSamples);
    mae = Math.max(entryPrice - lowest, 0);
  } else {
    const highest = Math.max(...priceSamples);
    mae = Math.max(highest - entryPrice, 0);
  }

  return Math.min(mae / entryPrice, 1);
}

// ── Composite ─────────────────────────────────────────────────────────────────

export function compositeScore(
  brier:    number,
  pnl:      number,
  drawdown: number,
  weights:  { accuracy: number; pnl: number; drawdown: number } = {
    accuracy: 0.4, pnl: 0.4, drawdown: 0.2,
  },
): number {
  return (
    weights.accuracy * brier +
    weights.pnl      * pnl   +
    weights.drawdown * (1 - drawdown)
  );
}

// ── Full computation ──────────────────────────────────────────────────────────

export function computeScores(
  prediction:   AgentPrediction,
  entryPrice:   number,
  outcomePrice: number,
  priceSamples: number[],
): ScoreComponents {
  const brier    = brierScoreNormalized(prediction, outcomePrice);
  const pnl      = computePnL(prediction, entryPrice, outcomePrice);
  const pnlNorm  = pnlNormalized(pnl, prediction.order.sizeUsdc);
  const drawdown = drawdownNormalized(prediction, entryPrice, priceSamples);
  const composite = compositeScore(brier, pnlNorm, drawdown);

  return { brierScore: brier, pnlNorm, drawdown, composite };
}

export function scaleForChain(scores: ScoreComponents): ScoreComponentsScaled {
  return {
    brierScore: Math.round(scores.brierScore * SCALE),
    pnlNorm:    Math.round(scores.pnlNorm    * SCALE),
    drawdown:   Math.round(scores.drawdown   * SCALE),
    composite:  Math.round(scores.composite  * SCALE),
  };
}
