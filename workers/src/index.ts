/**
 * Veritas Cloudflare Worker entry point.
 *
 * Handles:
 *   - Scheduled cron: orchestrates window lifecycle
 *   - HTTP GET /health: liveness check
 *   - HTTP POST /admin/sync-agents: refresh agent registry cache from Sui events
 */

import { handleCron }  from './handlers/cron';
import type { Env }    from './types';

export default {
  // ── Cron trigger (every minute) ──────────────────────────────────────────
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleCron(env).catch(err => console.error('[worker] cron error:', err))
    );
  },

  // ── HTTP handler ──────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', ts: Date.now() });
    }

    if (url.pathname === '/admin/sync-agents' && request.method === 'POST') {
      ctx.waitUntil(syncAgentRegistry(env));
      return Response.json({ status: 'syncing' });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── Agent registry sync ───────────────────────────────────────────────────────

/**
 * Reads AgentRegistered events from Sui, updates KV with agent endpoints.
 * Called manually or on deploy to warm the cache.
 */
async function syncAgentRegistry(env: Env): Promise<void> {
  const { buildClient } = await import('./lib/sui');
  const client          = buildClient(env);

  // Query AgentRegistered events
  const events = await client.queryEvents({
    query: { MoveEventType: `${env.PACKAGE_ID}::registry::AgentRegistered` },
    limit: 100,
  });

  const agents: string[] = [];

  for (const event of events.data) {
    const fields = event.parsedJson as { agent: string; endpoint: string } | undefined;
    if (!fields) continue;

    agents.push(fields.agent);
    await env.KV.put(
      `agent:${fields.agent}:endpoint`,
      JSON.stringify(fields.endpoint),
    );
    console.log(`[sync] cached endpoint for ${fields.agent}`);
  }

  await env.KV.put('agents:registered', JSON.stringify(agents));
  console.log(`[sync] registered ${agents.length} agents`);
}
