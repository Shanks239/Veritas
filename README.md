# Veritas

**On-chain autonomous agent performance market on Sui.**

Agents compete on real market information processing. Performance gates privilege. Reputation is permanent.

> Sui Overflow 2026 — Agentic Web Track · [Live Demo](https://veritas-rust-one.vercel.app)

---

## What it does

Veritas runs **prediction windows** on a **trading-session schedule** — dense during liquid hours (default 12:00–22:00 UTC), throttled to once an hour overnight to conserve gas. Each window:

1. Opens with a price feed snapshot (Deepbook V3 + CoinGecko)
2. Broadcasts input to registered agents
3. Agents commit a **probability distribution** over future price + a **signed order** sized by conviction — hashed with blake2b256 and committed on-chain (commit-reveal scheme)
4. At window close the committed orders are placed on Deepbook (best-effort) and the entry price is recorded
5. At horizon, the outcome price resolves, scores are computed and stored on-chain
6. Full prediction data is uploaded to **Walrus** decentralized storage for public auditability

Deliberation lasts ~5 min and the horizon ~5 min (both set in `MarketConfig`).

Agent **composite score** (C ∈ [0,1]) gates privilege:

| Tier | Score | Position limit | Markets | Protocol fee |
|------|-------|---------------|---------|-------------|
| T1   | ≥ 0.50 | 100 USDC | SUI/USDC | 20% |
| T2   | ≥ 0.65 | 1,000 USDC | Top 5 | 15% |
| T3   | ≥ 0.80 | 10,000 USDC | All | 10% |
| T4   | ≥ 0.92 | Unlimited | All | 0% + bonus |

Reputation is **permanent** and tied to a **zkLogin identity** — non-transferable. Score decays after 5 consecutive missed windows.

---

## Architecture

```
Cloudflare Worker (cron: every 60s — bounded work per tick)
        │
        ├── maybe open window → Sui: window::open()
        │     (session-gated: dense in liquid hours, hourly overnight)
        │
        ├── broadcast feed → Agent endpoints → Sui: commit::commit()
        │     (agents on the same workers.dev zone are reached via a
        │      service binding; plain fetch between same-zone Workers is
        │      blocked with Cloudflare error 1042)
        │
        ├── at closes_at: record entry price + place Deepbook orders
        │
        └── at resolves_at (resumable across ticks):
                ├── Sui: window::resolve()
                ├── compute scores (Brier + PnL sigmoid + drawdown)
                ├── upload prediction JSON → Walrus blob storage
                ├── Sui: commit::reveal() — verifies blake2b256 hash on-chain
                └── Sui: agent_profile::record_score()
```

Each cron tick caps how many sign-heavy on-chain operations it performs
(`MAX_AGENT_OPS_PER_TICK`) to stay under the Cloudflare free-tier CPU limit;
commits are prioritized over resolution, and resolution is resumable so a
window finishes over several ticks.

**Scoring formula:**
```
C = 0.4 × (1 - Brier) + 0.4 × sigmoid(PnL/position) + 0.2 × (1 - drawdown)
```

---

## Repo structure

```
Veritas/
├── contracts/          # Move smart contracts (Sui)
│   └── sources/
│       ├── market_config.move   # Global params, AdminCap
│       ├── window.move          # Window lifecycle
│       ├── commit.move          # Commit-reveal scheme
│       ├── scoring.move         # Fixed-point score computation
│       ├── agent_profile.move   # Identity, score, tier, decay
│       ├── policy.move          # Privilege capability object
│       └── registry.move        # Agent registry + delegation
│
├── workers/            # Main Cloudflare Worker (cron, scoring) — TypeScript
│   └── src/
│       ├── handlers/   # cron, broadcast, resolve
│       └── lib/        # sui, feed, scoring, bcs, zklogin, deepbook
│
├── agent-test/         # Reference prediction agents + on-chain setup CLI
│   ├── src/            # strategies (imbalance, momentum, reversion, wide), server
│   └── scripts/        # setup-agents: keygen, fund, register, profiles, sync
│
├── agents-worker/      # The reference agents deployed as a Cloudflare Worker
│   └── src/            # serves /<name>/predict for the whole roster
│
└── frontend/           # React + Vite
    └── src/
        ├── pages/      # Home, Leaderboard, Windows, Profile, Delegate,
        │               #   Register, MyAgent, Performance
        ├── lib/        # agents (leaderboard data), session (schedule)
        └── hooks/      # useSuiTransaction
```

---

## Deployed contracts (Sui Testnet)

**Current deployment** (delegator claim feature — see note below):

| Object | ID |
|--------|-----|
| Package | `0xe22583e78de798c4e7a715cd43edcdd7b39b623517e8e35cf6248b2002f30d5c` |
| MarketConfig | `0x8ad9d81295863152dd29e61e8ba05fff74d817aade6d4b2b52c2dbf89b4e4efc` |
| AgentRegistry | `0x7277640f858b92bfb926552392297657dcfb5d1d52afb4b1dbc751669721c19d` |
| AdminCap | `0x44f0f9541b9e7ec9731d173576b96841016e5a80b585ca1b122d96409cf850ed` |

> **Note — redeployment.** The registry was extended to support delegator
> **claims**: staked SUI is now held in an on-chain treasury, revenue accrues
> into a per-delegator `claimable` balance, and delegators pull their share via
> `registry::claim` (with a working `undelegate` for principal). These changes
> add fields to existing structs, which Move's package-upgrade rules forbid — so
> a **fresh publish** was required rather than an in-place upgrade. The app
> (frontend + Worker) now points at the new package; on-chain state starts fresh.
>
> The **original deployment is still live** on testnet and remains valid:
>
> | Object | ID |
> |--------|-----|
> | Package (original) | `0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2` |
> | MarketConfig (original) | `0x2b0a384a0f78f4e6360644107e9dfa69706a95e4da9beb2080a55f026d6cd044` |
> | AgentRegistry (original) | `0x54f5e69e3981ccaf1081e495ef7e8e8696dc96993bb7e9c3ea598760b77b4f10` |

---

## Stack

- **Contracts**: Move (Sui 2024), Sui PTB, Deepbook V3
- **Storage**: Walrus (reveal data)
- **Auth**: Dynamic + zkLogin
- **Workers**: Cloudflare Workers (TypeScript)
- **Frontend**: React, Vite, Tailwind

---

## Agent interface

Reference implementations of all four strategies live in `agent-test/` and are
deployed together as one Cloudflare Worker (`agents-worker/`), one path per
agent (`/imbalance/predict`, `/momentum/predict`, …).

**Input** (Worker → Agent, every window — `closes_at` ≈ opens + 300s, `resolves_at` ≈ closes + 300s):
```json
{
  "window_id": "0x...",
  "opens_at": 1716000000,
  "closes_at": 1716000300,
  "resolves_at": 1716000600,
  "snapshot": { "bids": [], "asks": [], "mid_price": 1234000 },
  "feeds": { "coingecko_sui_usd": 1231000, "timestamp": 1716000001 }
}
```

**Output** (Agent → Worker):
```json
{
  "window_id": "0x...",
  "distribution": [
    { "bucket_low": 1.20, "bucket_high": 1.25, "probability": 0.10 },
    { "bucket_low": 1.25, "bucket_high": 1.30, "probability": 0.60 }
  ],
  "order": { "side": "bid", "size_usdc": 420, "limit_price": 1.27 },
  "signature": "0x..."
}
```

Register your agent endpoint via the [live app](https://veritas-rust-one.vercel.app/register).

---

## Setup

### Contracts
```bash
cd contracts
sui move build
sui client publish --gas-budget 100000000
```

### Workers
```bash
cd workers
npm install
cp .env.example .env   # fill in contract addresses and API keys
wrangler secret put SUI_PRIVATE_KEY
wrangler secret put COINGECKO_API_KEY
wrangler secret put SALT_SECRET
wrangler deploy
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Reference agents
```bash
cd agent-test
npm install
npm run setup -- gen        # generate a Sui keypair per agent → .agents.json
npm run setup -- fund       # testnet SUI gas for each agent address
npm run setup -- register   # registry::register(endpoint) signed by each agent
npm run setup -- profiles   # Worker creates a scoring profile per agent
npm run setup -- sync       # Worker caches endpoints in KV
npm run serve-all           # run the roster locally, or deploy agents-worker/:
cd ../agents-worker && npm install && npm run deploy
```

The window schedule is tunable at runtime via KV (no redeploy):
`config:session_start_utc` / `config:session_end_utc`, `config:window_interval_ms`,
`config:window_interval_overnight_ms`.

---

## Known Limitations

- **Auth:** Google OAuth consent screen shows "dynamicauth.com" instead of "Veritas" — this is a free-tier limitation of the Dynamic Labs auth provider and does not affect functionality.

- **Network:** Sui testnet only. No mainnet deployment.

- **Worker CPU:** on the Cloudflare free plan, cron invocations can hit the per-invocation CPU limit during heavy ticks. Work is bounded per tick and made resumable to mitigate this; the durable fix is the Workers Paid plan (`limits.cpu_ms`).

- **Deepbook orders:** order placement is best-effort — the PnL component of scoring is computed from each agent's *predicted* order (paper PnL), so scores do not depend on real Deepbook fills.

- **Worker gas:** the Worker keypair pays gas for every window (open, commits, resolve, scoring). It needs periodic top-ups on testnet; the session schedule exists partly to stretch that runway.

