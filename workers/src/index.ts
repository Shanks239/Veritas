/**
 * Veritas Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /health                — liveness check
 *   GET  /auth/params           — returns current epoch for frontend nonce construction
 *   POST /auth/salt             — returns deterministic salt for a JWT sub
 *   POST /auth/register         — derives address from JWT, creates AgentProfile on-chain
 *   POST /admin/sync-agents     — refresh agent registry cache from Sui events
 */

import { handleCron }                                                 from './handlers/cron';
import { buildClient, buildKeypair, txCreateProfile }           from './lib/sui';
import { txCreateBalanceManager, txDepositToBalanceManager }    from './lib/deepbook';
import { getLoginParams, getOrCreateSalt, deriveAddress, decodeJwtClaims } from './lib/zklogin';
import type { Env }                                         from './types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  // ── Cron trigger (every minute) ──────────────────────────────────────────
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleCron(env).catch(err => console.error('[worker] cron error:', err))
    );
  },

  // ── HTTP handler ──────────────────────────────────────────────────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url    = new URL(request.url);
    const client = buildClient(env);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // ── GET /health ───────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', ts: Date.now() });
    }

    // ── GET /auth/params ──────────────────────────────────────────────────
    // Returns current epoch so frontend can construct the OAuth nonce.
    // Frontend: generateNonce(ephemeralPublicKey, maxEpoch, randomness)
    if (url.pathname === '/auth/params' && request.method === 'GET') {
      const params = await getLoginParams(client);
      return Response.json({
        ...params,
        googleClientId: env.GOOGLE_CLIENT_ID,
        proverUrl:      'https://prover.mystenlabs.com/v1',
      });
    }

    // ── POST /auth/salt ───────────────────────────────────────────────────
    // Body: { jwt: string }
    // Returns: { salt: string }
    // Called by frontend after OAuth callback to get the user's salt.
    if (url.pathname === '/auth/salt' && request.method === 'POST') {
      try {
        const { jwt } = await request.json() as { jwt: string };
        const claims  = decodeJwtClaims(jwt);
        const salt    = await getOrCreateSalt(claims.sub, env);
        return Response.json({ salt });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 400 });
      }
    }

    // ── POST /auth/register ───────────────────────────────────────────────
    // Body: { jwt: string }
    // Derives the user's Sui address, creates AgentProfile on-chain if not exists.
    // Returns: { address: string, profileId: string | null, isNew: boolean }
    //
    // NOTE: Full zkLogin signature verification happens on-chain when the
    // profile creation tx is submitted. The Worker does NOT verify the JWT
    // signature itself — it trusts the ZK proof submitted with the tx.
    // For the hackathon, the Worker submits the profile creation with AdminCap.
    if (url.pathname === '/auth/register' && request.method === 'POST') {
      try {
        const { jwt } = await request.json() as { jwt: string };
        const claims   = decodeJwtClaims(jwt);
        const salt     = await getOrCreateSalt(claims.sub, env);
        const address  = deriveAddress(jwt, salt);

        // Check if profile already exists in KV cache
        const existingProfile = await env.KV.get(`agent:${address}:profile_id`);
        if (existingProfile) {
          return Response.json({ address, profileId: existingProfile, isNew: false });
        }

        // Create AgentProfile on-chain
        const keypair = buildKeypair(env);
        const profileId = await txCreateProfile(client, keypair, env, address);

        // Cache profile ID
        await env.KV.put(`agent:${address}:profile_id`, profileId);

        return Response.json({ address, profileId, isNew: true });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 400 });
      }
    }

    // ── POST /profile/ensure ─────────────────────────────────────────────
    // Body: { agentAddress: string }
    // Creates a Worker-owned AgentProfile if one is not already cached in KV.
    // Worker must own the profile so it can call record_score/record_miss later.
    if (url.pathname === '/profile/ensure' && request.method === 'POST') {
      try {
        const { agentAddress } = await request.json() as { agentAddress: string };
        if (!agentAddress) return json({ error: 'agentAddress required' }, 400);

        const existing = await env.KV.get(`agent:${agentAddress}:profile_id`);
        if (existing) return json({ profileId: existing, isNew: false });

        const keypair   = buildKeypair(env);
        const profileId = await txCreateProfile(client, keypair, env, agentAddress);
        await env.KV.put(`agent:${agentAddress}:profile_id`, profileId);

        return json({ profileId, isNew: true });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }

    // ── GET /window/:windowId/stats ───────────────────────────────────────
    // Returns commit count for a window by listing KV keys with that prefix.
    const statsMatch = url.pathname.match(/^\/window\/([^/]+)\/stats$/);
    if (statsMatch && request.method === 'GET') {
      const windowId = statsMatch[1];
      const { keys } = await env.KV.list({ prefix: `window:${windowId}:commit:` });
      return json({ commitCount: keys.length });
    }

    // ── POST /admin/sync-agents ───────────────────────────────────────────
    if (url.pathname === '/admin/sync-agents' && request.method === 'POST') {
      ctx.waitUntil(syncAgentRegistry(env));
      return json({ status: 'syncing' });
    }

    // ── POST /admin/deposit-deepbook ──────────────────────────────────────
    // Deposit into the existing BalanceManager.
    // Body: { coinKey: 'SUI' | 'DBUSDC', amount: number }
    if (url.pathname === '/admin/deposit-deepbook' && request.method === 'POST') {
      try {
        if (!env.BALANCE_MANAGER_ID) return json({ error: 'BALANCE_MANAGER_ID not set' }, 400);
        const { coinKey, amount } = await request.json() as { coinKey: string; amount: number };
        const keypair = buildKeypair(env);
        const digest  = await txDepositToBalanceManager(client, keypair, env.BALANCE_MANAGER_ID, coinKey, amount);
        return json({ digest, coinKey, amount });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }

    // ── POST /admin/setup-deepbook ────────────────────────────────────────
    // One-time: creates a shared BalanceManager for the Worker keypair.
    // Returns its object ID — set it as BALANCE_MANAGER_ID in wrangler.toml and redeploy.
    // Optional body: { deposit?: { coinKey: 'SUI' | 'DBUSDC', amount: number } }
    if (url.pathname === '/admin/setup-deepbook' && request.method === 'POST') {
      try {
        const keypair          = buildKeypair(env);
        const balanceManagerId = await txCreateBalanceManager(client, keypair);
        console.log(`[setup] BalanceManager created: ${balanceManagerId}`);

        const body = await request.json().catch(() => ({})) as { deposit?: { coinKey: string; amount: number } };
        if (body.deposit) {
          await txDepositToBalanceManager(client, keypair, balanceManagerId, body.deposit.coinKey, body.deposit.amount);
          console.log(`[setup] deposited ${body.deposit.amount} ${body.deposit.coinKey}`);
        }

        return json({
          balanceManagerId,
          next: 'Set BALANCE_MANAGER_ID in wrangler.toml [vars] and redeploy',
        });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }

    // ── GET /admin/kv-state ───────────────────────────────────────────────
    // Returns cron-critical KV keys so we can see why windows aren't opening.
    if (url.pathname === '/admin/kv-state' && request.method === 'GET') {
      const [lock, active, agents] = await Promise.all([
        env.KV.get('window_open_lock'),
        env.KV.get('active_windows'),
        env.KV.get('agents:registered'),
      ]);
      return json({ lock, active: active ? JSON.parse(active) : null, agents: agents ? JSON.parse(agents) : null });
    }

    // ── POST /admin/open-window ───────────────────────────────────────────
    // Bypass the lock and try to open a window — returns digest or error.
    if (url.pathname === '/admin/open-window' && request.method === 'POST') {
      try {
        const keypair  = buildKeypair(env);
        const { txOpenWindow } = await import('./lib/sui');
        const windowId = await txOpenWindow(client, keypair, env);
        return json({ windowId });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }

    // ── POST /admin/broadcast ─────────────────────────────────────────────
    // Test the full broadcast→commit flow for a specific window.
    // Body: { windowId: string }
    if (url.pathname === '/admin/broadcast' && request.method === 'POST') {
      try {
        const { windowId } = await request.json() as { windowId: string };
        if (!windowId) return json({ error: 'windowId required' }, 400);

        const keypair = buildKeypair(env);
        const { broadcastAndCommit } = await import('./handlers/broadcast');
        const { assembleFeedSnapshot } = await import('./lib/feed');

        // Check if feed exists in KV; if not, build one on the fly
        let feedRaw = await env.KV.get(`window:${windowId}:feed`);
        if (!feedRaw) {
          const feed = await assembleFeedSnapshot(windowId, client, env, keypair);
          feedRaw = JSON.stringify(feed);
          await env.KV.put(`window:${windowId}:feed`, feedRaw);
        }

        // Build a minimal meta object so broadcastAndCommit can run
        const now = Date.now();
        const meta = {
          windowId,
          opensAt:    now - 5000,
          closesAt:   now + 50000,
          resolvesAt: now + 350000,
          phase:      'deliberating' as const,
        };

        await broadcastAndCommit(meta, client, keypair, env);
        return json({ ok: true, windowId });
      } catch (err) {
        return json({ error: String(err) }, 400);
      }
    }

    // ── DELETE /admin/kv/:key ─────────────────────────────────────────────
    // Delete a KV key by name (e.g. window_open_lock to unstick the cron).
    const kvDeleteMatch = url.pathname.match(/^\/admin\/kv\/(.+)$/);
    if (kvDeleteMatch && request.method === 'DELETE') {
      await env.KV.delete(kvDeleteMatch[1]);
      return json({ deleted: kvDeleteMatch[1] });
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
  const client = buildClient(env);

  const events = await client.queryEvents({
    query: { MoveEventType: `${env.PACKAGE_ID}::registry::AgentRegistered` },
    limit: 100,
  });

  const agents: string[] = [];
  for (const event of events.data) {
    const fields = event.parsedJson as { agent: string; endpoint: number[] } | undefined;
    if (!fields) continue;
    agents.push(fields.agent);
    // Sui serializes vector<u8> event fields as a number array in parsedJson
    const endpoint = new TextDecoder().decode(new Uint8Array(fields.endpoint));
    await env.KV.put(`agent:${fields.agent}:endpoint`, JSON.stringify(endpoint));
    console.log(`[sync] cached endpoint for ${fields.agent}: ${endpoint}`);
  }

  await env.KV.put('agents:registered', JSON.stringify(agents));
  console.log(`[sync] registered ${agents.length} agents`);
}
