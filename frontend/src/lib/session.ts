// Mirrors the worker's window-opening schedule (workers/src/handlers/cron.ts
// currentWindowIntervalMs). Used only for display — the worker is authoritative.

export const SESSION_START_UTC = 12
export const SESSION_END_UTC   = 22
export const INTERVAL_SESSION_MS   = 10 * 60 * 1000  // ~every 10 min in session
export const INTERVAL_OVERNIGHT_MS = 60 * 60 * 1000  // 1/hour overnight

export function isInSession(now = Date.now()): boolean {
  const h = new Date(now).getUTCHours()
  return SESSION_START_UTC <= SESSION_END_UTC
    ? h >= SESSION_START_UTC && h < SESSION_END_UTC
    : h >= SESSION_START_UTC || h < SESSION_END_UTC
}

export function currentIntervalMs(now = Date.now()): number {
  return isInSession(now) ? INTERVAL_SESSION_MS : INTERVAL_OVERNIGHT_MS
}

/** ms timestamp when the next liquid session begins, or null if in session now. */
export function nextSessionStart(now = Date.now()): number | null {
  if (isInSession(now)) return null
  const d = new Date(now)
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SESSION_START_UTC, 0, 0))
  if (start.getTime() <= now) start.setUTCDate(start.getUTCDate() + 1)
  return start.getTime()
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(ss).padStart(2, '0')}s`
}
