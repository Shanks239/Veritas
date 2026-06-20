import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { PACKAGE_ID } from './agents'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })

export interface WindowData {
  id:          string
  opensAt:     number
  closesAt:    number
  resolvesAt:  number
  commitCount: number
  resolved:    boolean
}

export const PHASES: Record<string, { label: string; color: string; dot: string }> = {
  deliberating:     { label: 'Deliberating',     color: '#60a5fa', dot: '#3b82f6' },
  awaiting_horizon: { label: 'Awaiting horizon', color: '#fbbf24', dot: '#f59e0b' },
  resolvable:       { label: 'Resolvable',       color: '#34d399', dot: '#10b981' },
  resolved:         { label: 'Resolved',         color: 'rgba(255,255,255,0.2)', dot: 'rgba(255,255,255,0.15)' },
}

export function getPhase(w: WindowData): string {
  const now = Date.now()
  if (now < w.closesAt)   return 'deliberating'
  if (now < w.resolvesAt) return 'awaiting_horizon'
  if (!w.resolved)        return 'resolvable'
  return 'resolved'
}

/** Recent windows, newest first, with on-chain resolved status. */
export async function fetchWindows(): Promise<WindowData[]> {
  const [opened, resolved] = await Promise.all([
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::window::WindowOpened` },   limit: 20, order: 'descending' }),
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::window::WindowResolved` }, limit: 50, order: 'descending' }),
  ])

  const resolvedIds = new Set(resolved.data.map(e => (e.parsedJson as { window_id: string }).window_id))

  return opened.data.map(e => {
    const f = e.parsedJson as { window_id: string; opens_at: string; closes_at: string; resolves_at: string }
    return {
      id:          f.window_id,
      opensAt:     Number(f.opens_at),
      closesAt:    Number(f.closes_at),
      resolvesAt:  Number(f.resolves_at),
      commitCount: 0,
      resolved:    resolvedIds.has(f.window_id),
    }
  })
}
