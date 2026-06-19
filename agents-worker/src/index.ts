/**
 * Veritas agents — Cloudflare Worker.
 *
 * Serves the whole agent roster from one always-on deployment. Each agent gets
 * its own path:
 *
 *   POST /<name>/predict   → prediction for that agent (the URL registered on-chain)
 *   GET  /<name>/health    → agent liveness + identity
 *   GET  /health           → worker liveness
 *   GET  /                 → roster listing
 *
 * Strategy logic is shared with the local Express agents (single source of
 * truth in ../../agent-test/src/strategies). The roster — which name maps to
 * which strategy + on-chain address — is baked into wrangler.toml [vars] AGENTS
 * so the Worker returns the exact agentAddress the registry expects.
 */

import { getStrategy, type WorkerPayload } from '../../agent-test/src/strategies';

interface AgentEntry {
  strategy: string;
  address:  string;
}

interface Env {
  AGENTS: string; // JSON: { "<name>": { "strategy": "...", "address": "0x..." }, ... }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function loadRoster(env: Env): Record<string, AgentEntry> {
  try {
    return JSON.parse(env.AGENTS) as Record<string, AgentEntry>;
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const roster = loadRoster(env);

    // ── GET / — roster listing ────────────────────────────────────────────
    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        worker: 'veritas-agents',
        agents: Object.entries(roster).map(([name, a]) => ({
          name,
          strategy: a.strategy,
          address:  a.address,
          predict:  `${url.origin}/${name}/predict`,
        })),
      });
    }

    // ── GET /health — worker liveness ─────────────────────────────────────
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', agents: Object.keys(roster), ts: Date.now() });
    }

    // ── /<name>/(predict|health) ──────────────────────────────────────────
    const m = url.pathname.match(/^\/([a-zA-Z0-9_-]+)\/(predict|health)$/);
    if (m) {
      const [, name, action] = m;
      const agent = roster[name];
      if (!agent) return json({ error: `unknown agent "${name}"` }, 404);

      if (action === 'health' && request.method === 'GET') {
        return json({ status: 'ok', name, strategy: agent.strategy, address: agent.address, ts: Date.now() });
      }

      if (action === 'predict' && request.method === 'POST') {
        let payload: WorkerPayload;
        try {
          payload = await request.json() as WorkerPayload;
        } catch {
          return json({ error: 'invalid JSON body' }, 400);
        }
        if (!payload?.window_id) return json({ error: 'window_id is required' }, 400);

        const { distribution, order } = getStrategy(agent.strategy)(payload);
        return json({
          windowId:     payload.window_id,
          agentAddress: agent.address,
          distribution,
          order,
          signature:    '0x00', // Worker does not verify agent signatures (hackathon)
        });
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
