/**
 * Main cron handler. Runs every minute.
 *
 * Responsibilities:
 *   1. Open a new window if interval has elapsed since the last one.
 *   2. For each active window in 'deliberating' phase:
 *        — broadcast feed + input payload to all registered agents
 *        — collect predictions, submit commits on-chain
 *        — record entry price when deliberation closes
 *   3. For each window in 'resolvable' phase:
 *        — fetch outcome price from Deepbook
 *        — resolve window on-chain
 *        — reveal + score each committed agent
 *        — update tiers if changed
 *
 * Window phase transitions:
 *   deliberating     → awaiting_horizon  (at closesAt)
 *   awaiting_horizon → resolvable        (at resolvesAt)
 *   resolvable       → resolved          (after txResolveWindow succeeds)
 */

import { buildClient, buildKeypair, txOpenWindow } from '../lib/sui';
import { assembleFeedSnapshot, fetchMidPrice }     from '../lib/feed';
import { broadcastAndCommit }                      from './broadcast';
import { resolveAndScore }                         from './resolve';
import { KV as KVKey, type Env, type WindowMeta } from '../types';

const WINDOW_OPEN_LOCK_TTL = 90; // seconds — prevents double-open on concurrent invocations

export async function handleCron(env: Env): Promise<void> {
  const client  = buildClient(env);
  const keypair = buildKeypair(env);

  await Promise.all([
    maybeOpenWindow(client, keypair, env),
    processActiveWindows(client, keypair, env),
  ]);
}

// ── Open new window ───────────────────────────────────────────────────────────

async function maybeOpenWindow(
  client:  ReturnType<typeof buildClient>,
  keypair: ReturnType<typeof buildKeypair>,
  env:     Env,
): Promise<void> {
  // Best-effort distributed lock. KV has no atomic CAS, so two concurrent invocations
  // can both read null and both proceed. Cloudflare Scheduled Events are delivered
  // at-most-once per runtime isolate in practice, but for production correctness
  // replace this with a Durable Object alarm which provides true single-execution.
  const lockKey   = 'window_open_lock';
  const existing  = await env.KV.get(lockKey);
  if (existing) return;

  await env.KV.put(lockKey, '1', { expirationTtl: WINDOW_OPEN_LOCK_TTL });

  try {
    const windowId = await txOpenWindow(client, keypair, env);
    const now      = Date.now();

    // Read timing params from KV cache (populated at deploy, refreshed on config update)
    const deliberationMs = Number(await env.KV.get('config:deliberation_ms') ?? '60000');
    const horizonMs      = Number(await env.KV.get('config:horizon_ms')      ?? '300000');

    const meta: WindowMeta = {
      windowId,
      opensAt:    now,
      closesAt:   now + deliberationMs,
      resolvesAt: now + deliberationMs + horizonMs,
      phase:      'deliberating',
    };

    // Fetch and store feed snapshot immediately (agents need t=0 state)
    const feed = await assembleFeedSnapshot(windowId, client, env, keypair);

    await Promise.all([
      env.KV.put(KVKey.windowMeta(windowId), JSON.stringify(meta)),
      env.KV.put(KVKey.windowFeed(windowId), JSON.stringify(feed)),
      addToActiveWindows(env, windowId),
    ]);

    console.log(`[cron] opened window ${windowId}`);

    // Broadcast immediately — the active-window list is read concurrently so the
    // new window won't appear in processActiveWindows until the NEXT tick, which
    // arrives exactly at closesAt (60 s). Committing at T=0 is the only safe window.
    await broadcastAndCommit(meta, client, keypair, env)
      .catch(err => console.error('[cron] immediate broadcast failed:', err));
  } catch (err) {
    console.error('[cron] failed to open window:', err);
    await env.KV.delete(lockKey); // release lock on failure so next cron can retry
  }
}

// ── Process active windows ────────────────────────────────────────────────────

async function processActiveWindows(
  client:  ReturnType<typeof buildClient>,
  keypair: ReturnType<typeof buildKeypair>,
  env:     Env,
): Promise<void> {
  const activeIds = await getActiveWindows(env);
  const now       = Date.now();

  await Promise.allSettled(
    activeIds.map(id => processWindow(id, now, client, keypair, env)),
  );
}

async function processWindow(
  windowId: string,
  now:      number,
  client:   ReturnType<typeof buildClient>,
  keypair:  ReturnType<typeof buildKeypair>,
  env:      Env,
): Promise<void> {
  const raw = await env.KV.get(KVKey.windowMeta(windowId));
  if (!raw) return;

  const meta: WindowMeta = JSON.parse(raw);

  switch (meta.phase) {
    case 'deliberating': {
      // Broadcast + collect commits if deliberation is still open
      if (now < meta.closesAt) {
        await broadcastAndCommit(meta, client, keypair, env);
      } else {
        // Deliberation just closed — record entry price, advance phase
        const entryPrice = await fetchMidPrice(client, keypair.toSuiAddress(), env.SUI_NETWORK, env.COINGECKO_API_KEY);
        meta.entryPrice  = entryPrice;
        meta.phase       = 'awaiting_horizon';
        await env.KV.put(KVKey.windowMeta(windowId), JSON.stringify(meta));
        console.log(`[cron] window ${windowId} closed, entry price: ${entryPrice}`);
      }
      break;
    }

    case 'awaiting_horizon': {
      // Nothing to do — just waiting for horizon to elapse
      if (now >= meta.resolvesAt) {
        meta.phase = 'resolvable';
        await env.KV.put(KVKey.windowMeta(windowId), JSON.stringify(meta));
      }
      break;
    }

    case 'resolvable': {
      await resolveAndScore(meta, client, keypair, env);
      meta.phase = 'resolved';
      await env.KV.put(KVKey.windowMeta(windowId), JSON.stringify(meta));
      await removeFromActiveWindows(env, windowId);
      console.log(`[cron] window ${windowId} resolved and scored`);
      break;
    }

    case 'resolved':
      // Already handled — should have been removed from active list
      await removeFromActiveWindows(env, windowId);
      break;
  }
}

// ── Active window list helpers ────────────────────────────────────────────────

async function getActiveWindows(env: Env): Promise<string[]> {
  const raw = await env.KV.get(KVKey.activeWindows());
  return raw ? JSON.parse(raw) : [];
}

async function addToActiveWindows(env: Env, windowId: string): Promise<void> {
  const ids = await getActiveWindows(env);
  if (!ids.includes(windowId)) {
    ids.push(windowId);
    await env.KV.put(KVKey.activeWindows(), JSON.stringify(ids));
  }
}

async function removeFromActiveWindows(env: Env, windowId: string): Promise<void> {
  const ids     = await getActiveWindows(env);
  const updated = ids.filter(id => id !== windowId);
  await env.KV.put(KVKey.activeWindows(), JSON.stringify(updated));
}
