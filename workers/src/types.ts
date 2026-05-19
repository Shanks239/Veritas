// ── Environment ───────────────────────────────────────────────────────────────

export interface Env {
  KV:              KVNamespace;
  SUI_NETWORK:     string;
  PACKAGE_ID:      string;
  MARKET_CONFIG_ID: string;
  REGISTRY_ID:     string;
  SUI_PRIVATE_KEY: string;   // secret
  COINGECKO_API_KEY: string; // secret
  SALT_SECRET:     string;   // secret — used for deterministic salt derivation
  GOOGLE_CLIENT_ID: string;  // secret — Google OAuth app client ID
}

// ── Window ────────────────────────────────────────────────────────────────────

export type WindowPhase = 'deliberating' | 'awaiting_horizon' | 'resolvable' | 'resolved';

export interface WindowMeta {
  windowId:    string;   // Sui object ID
  opensAt:     number;   // ms timestamp
  closesAt:    number;
  resolvesAt:  number;
  phase:       WindowPhase;
  entryPrice?: number;   // Deepbook mid at closesAt, scaled 1e6
}

// ── Feed ──────────────────────────────────────────────────────────────────────

export interface DeepbookLevel {
  price: number;  // scaled 1e6
  qty:   number;  // scaled 1e6
}

export interface FeedSnapshot {
  windowId:       string;
  timestamp:      number;
  bids:           DeepbookLevel[];
  asks:           DeepbookLevel[];
  midPrice:       number;   // (best_bid + best_ask) / 2, scaled 1e6
  coingeckoPrice: number;   // USD, scaled 1e6
  signature:      string;   // Worker Ed25519 sig over canonical JSON
}

// ── Prediction ────────────────────────────────────────────────────────────────

export interface PriceBucket {
  bucketLow:   number;   // price lower bound, scaled 1e6
  bucketHigh:  number;   // price upper bound, scaled 1e6
  probability: number;   // [0,1] — must sum to 1 across all buckets
}

export type OrderSide = 'bid' | 'ask';

export interface PredictionOrder {
  side:       OrderSide;
  sizeUsdc:   number;   // notional, scaled 1e6
  limitPrice: number;   // scaled 1e6
}

export interface AgentPrediction {
  windowId:     string;
  agentAddress: string;
  distribution: PriceBucket[];
  order:        PredictionOrder;
  signature:    string;   // agent Ed25519 sig over canonical BCS bytes
}

// ── Commit record (stored in KV) ──────────────────────────────────────────────

export interface CommitRecord {
  windowId:     string;
  agentAddress: string;
  commitId:     string;   // Sui object ID of on-chain Commit
  hash:         string;   // hex blake2b256 of canonical BCS
  prediction:   AgentPrediction;
}

// ── Score ─────────────────────────────────────────────────────────────────────

export interface ScoreComponents {
  brierScore:  number;   // (1 - Brier) normalized [0,1]
  pnlNorm:     number;   // sigmoid(PnL/position) [0,1]
  drawdown:    number;   // max adverse excursion / position [0,1]
  composite:   number;   // weighted composite C [0,1]
}

// Scaled versions for on-chain submission (multiply by 10_000)
export interface ScoreComponentsScaled {
  brierScore:  number;   // [0, 10_000]
  pnlNorm:     number;
  drawdown:    number;
  composite:   number;
}

// ── KV key helpers ────────────────────────────────────────────────────────────

export const KV = {
  activeWindows:    ()                            => 'active_windows',
  windowMeta:       (id: string)                  => `window:${id}:meta`,
  windowFeed:       (id: string)                  => `window:${id}:feed`,
  windowCommit:     (id: string, agent: string)   => `window:${id}:commit:${agent}`,
  windowAgents:     (id: string)                  => `window:${id}:agents`,
  agentEndpoint:    (addr: string)                => `agent:${addr}:endpoint`,
} as const;
