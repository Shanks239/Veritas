# Veritas agents

A small fleet of prediction agents for the Veritas market. Each agent is an
HTTP server exposing `POST /predict`, registered on-chain under its own Sui
address. The Worker broadcasts the feed to every registered endpoint each
window and commits the responses.

## Roster

| Agent       | Strategy                                                        | Port |
|-------------|-----------------------------------------------------------------|------|
| `imbalance` | Leans toward the heavier side of the resting order book         | 3002 |
| `momentum`  | Trades the direction of CoinGecko-vs-Deepbook drift             | 3003 |
| `reversion` | Fades the drift, betting price returns to the book mid          | 3004 |
| `wide`      | Low-conviction baseline — wide distribution, small fixed order  | 3005 |

Strategies live in `src/strategies.ts`. Edit ports/roster in `src/agents.config.ts`.

## Run the agents

```bash
npm install
npm run serve-all          # all four on ports 3002–3005
# or a single agent:
PORT=3001 STRATEGY=momentum AGENT_ADDRESS=0x... npm run dev
```

## Wire them up (full setup)

Generated keys are written to `.agents.json` (gitignored — contains secret keys).
Set `WORKER_URL` to your deployed Worker. `PUBLIC_BASE_URL` is the origin the
Worker will POST to — for local agents, expose each port with a tunnel
(`cloudflared`/`ngrok`) and put the resulting URL in `.agents.json`’s `endpoint`
field before registering.

```bash
export WORKER_URL=https://veritas-worker.<account>.workers.dev

npm run setup -- gen        # 1. generate a Sui keypair per agent
npm run setup -- fund       # 2. request testnet SUI gas (faucet)
npm run setup -- register   # 3. registry::register(endpoint) signed by each agent
npm run setup -- profiles   # 4. Worker creates an AgentProfile it owns (for scoring)
npm run setup -- sync       # 5. Worker /admin/sync-agents → caches endpoints in KV

npm run setup -- all        # or do 1–5 in sequence
npm run setup -- status     # address / balance / registered state
```

Changed an endpoint URL? Edit `.agents.json`, then:

```bash
npm run setup -- set-endpoint   # registry::update_endpoint
npm run setup -- sync
```

### Notes

- `register` is signed by each agent's own key (`ctx.sender()` on-chain), so
  each address needs gas first (`fund`).
- The Cloudflare Worker cannot reach `localhost`. For a deployed Worker, the
  registered `endpoint` must be publicly reachable.
- Defaults (`PACKAGE_ID`, `REGISTRY_ID`, testnet) match the deployed contracts;
  override via env if they change.
