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
import { KV as KVKey, type Env, type WindowMeta, type TickBudget } from '../types';

const WINDOW_OPEN_LOCK_TTL = 90; // seconds — prevents double-open on concurrent invocations

// Per-cron-tick cap on CPU-heavy on-chain operations (each ≈ one or two
// build+sign cycles). Tx building/signing dominates CPU, so we bound how much
// runs per invocation instead of doing everything at once (which was hitting
// exceededCpu). Sized to the agent roster: one deliberation tick commits all
// agents, and the remaining ticks of the 300s window drain resolution/scoring
// (resumable across ticks). Observed CPU per tick stays in the tens of ms.
// Raise further on the Workers Paid plan (limits.cpu_ms up to 30000).
const MAX_AGENT_OPS_PER_TICK = 4;

export async function handleCron(env: Env): Promise<void> {
  const client  = buildClient(env);
  const keypair = buildKeypair(env);

  // Shared budget for this invocation. Run sequentially (not Promise.all) so the
  // two paths draw from the same budget without racing on the counter.
  const budget: TickBudget = { remaining: MAX_AGENT_OPS_PER_TICK };

  await maybeOpenWindow(client, keypair, env, budget);
  await processActiveWindows(client, keypair, env, budget);
}

// ── Open new window ───────────────────────────────────────────────────────────

async function maybeOpenWindow(
  client:  ReturnType<typeof buildClient>,
  keypair: ReturnType<typeof buildKeypair>,
  env:     Env,
  budget:  TickBudget,
): Promise<void> {
  // Best-effort distributed lock. KV has no atomic CAS, so two concurrent invocations
  // can both read null and both proceed. Cloudflare Scheduled Events are delivered
  // at-most-once per runtime isolate in practice, but for production correctness
  // replace this with a Durable Object alarm which provides true single-execution.
  const lockKey   = 'window_open_lock';
  const existing  = await env.KV.get(lockKey);
  if (existing) return;

  // Gate on window interval — without this, a window opens every cron tick,
  // burning ~4.5 SUI/day in gas on testnet.
  const intervalMs   = Number(await env.KV.get('config:window_interval_ms') ?? '600000');
  const lastOpenedAt = Number(await env.KV.get('last_window_opened_at') ?? '0');
  if (Date.now() - lastOpenedAt < intervalMs) return;

  // Opening signs a tx (open) + the feed snapshot — defer to a later tick if this
  // tick's CPU budget is already spent on commits/scoring.
  if (budget.remaining <= 0) return;
  budget.remaining--;

  await env.KV.put(lockKey, '1', { expirationTtl: WINDOW_OPEN_LOCK_TTL });

  try {
    // Use the contract's own opens/closes/resolves timestamps (from the
    // WindowOpened event) so off-chain phase transitions line up exactly with
    // on-chain — otherwise resolve() can be called before the real horizon.
    const { windowId, initialSharedVersion, opensAt, closesAt, resolvesAt } = await txOpenWindow(client, keypair, env);
    const now = Date.now();

    const meta: WindowMeta = {
      windowId,
      opensAt,
      closesAt,
      resolvesAt,
      phase:      'deliberating',
      initialSharedVersion,
    };

    // Fetch and store feed snapshot immediately (agents need t=0 state)
    const feed = await assembleFeedSnapshot(windowId, client, env, keypair);

    await Promise.all([
      env.KV.put(KVKey.windowMeta(windowId), JSON.stringify(meta)),
      env.KV.put(KVKey.windowFeed(windowId), JSON.stringify(feed)),
      env.KV.put('last_window_opened_at', String(now)),
      addToActiveWindows(env, windowId),
    ]);

    console.log(`[cron] opened window ${windowId}`);
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
  budget:  TickBudget,
): Promise<void> {
  const activeIds = await getActiveWindows(env);
  const now       = Date.now();

  // Load metas once. Run sequentially so windows share the CPU budget.
  const metas = (await Promise.all(activeIds.map(async id => {
    const raw = await env.KV.get(KVKey.windowMeta(id));
    return raw ? JSON.parse(raw) as WindowMeta : null;
  }))).filter((m): m is WindowMeta => m !== null);

  // Phase transitions are cheap (no tx) — always do them first so windows
  // advance even when the budget is exhausted.
  for (const meta of metas) {
    await advancePhase(meta, now, client, keypair, env);
  }

  // Commits come before scoring: a missed commit means the agent misses the
  // window (score decay), whereas a lagging resolution just records scores late.
  for (const meta of metas) {
    if (budget.remaining <= 0) break;
    if (meta.phase === 'deliberating' && now < meta.closesAt) {
      await broadcastAndCommit(meta, client, keypair, env, budget);
    }
  }

  // Spend any remaining budget resolving + scoring (resumable across ticks).
  for (const meta of metas) {
    if (budget.remaining <= 0) break;
    if (meta.phase === 'resolvable') {
      const done = await resolveAndScore(meta, client, keypair, env, budget);
      if (done) {
        meta.phase = 'resolved';
        await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
        await removeFromActiveWindows(env, meta.windowId);
        console.log(`[cron] window ${meta.windowId} resolved and scored`);
      }
    }
  }
}

/**
 * Cheap, no-transaction phase advancement: close deliberation (record entry
 * price) and mark windows resolvable once the horizon elapses. Does not consume
 * the tick budget.
 */
async function advancePhase(
  meta:    WindowMeta,
  now:     number,
  client:  ReturnType<typeof buildClient>,
  keypair: ReturnType<typeof buildKeypair>,
  env:     Env,
): Promise<void> {
  if (meta.phase === 'deliberating' && now >= meta.closesAt) {
    const entryPrice = await fetchMidPrice(client, keypair.toSuiAddress(), env.SUI_NETWORK, env.COINGECKO_API_KEY);
    meta.entryPrice  = entryPrice;
    meta.phase       = 'awaiting_horizon';
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
    console.log(`[cron] window ${meta.windowId} closed, entry price: ${entryPrice}`);
  } else if (meta.phase === 'awaiting_horizon' && now >= meta.resolvesAt) {
    meta.phase = 'resolvable';
    await env.KV.put(KVKey.windowMeta(meta.windowId), JSON.stringify(meta));
  } else if (meta.phase === 'resolved') {
    await removeFromActiveWindows(env, meta.windowId);
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
