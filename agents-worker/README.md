# veritas-agents (Cloudflare Worker)

Always-on host for the Veritas prediction agents. One Worker serves the whole
roster behind a stable `*.workers.dev` URL, so the on-chain endpoints never
change and the agents stay reachable independent of any laptop.

```
POST /<name>/predict   prediction for that agent (the URL registered on-chain)
GET  /<name>/health    agent identity + liveness
GET  /health           worker liveness
GET  /                 roster listing
```

Strategy logic is shared with the local agents — single source of truth in
`../agent-test/src/strategies.ts`. The roster (name → strategy + on-chain
address) is baked into `wrangler.toml` `[vars] AGENTS`; addresses are public,
secret keys never leave `../agent-test/.agents.json`.

## Deploy

```bash
npm install
npm run typecheck
npm run deploy            # → https://veritas-agents.<account>.workers.dev
```

Then point the agents' on-chain endpoints at this Worker and refresh the cache
(from `../agent-test`):

```bash
cd ../agent-test
AGENTS_WORKER_URL=https://veritas-agents.<account>.workers.dev npm run setup -- endpoints
npm run setup -- register      # first time (or: set-endpoint if already registered)
npm run setup -- sync
```

## Changing the roster

After regenerating keys or editing the roster, re-sync the baked config:

```bash
cd ../agent-test && npm run setup -- worker-config   # rewrites [vars] AGENTS
cd ../agents-worker && npm run deploy
```

## Cost

Pure compute, no subrequests, sub-millisecond CPU per call. At one window/minute
across 4 agents that's ~5.8k requests/day — well within the Workers free tier.
