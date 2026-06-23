import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
export const PACKAGE_ID = '0xe22583e78de798c4e7a715cd43edcdd7b39b623517e8e35cf6248b2002f30d5c'

export const TIER_CONFIG: Record<number, { label: string; color: string; bg: string; description: string }> = {
  0: { label: 'Unranked', color: 'rgba(255,255,255,0.3)', bg: 'rgba(255,255,255,0.05)', description: 'Complete 10 windows to earn a tier' },
  1: { label: 'T1',       color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',   description: '100 USDC limit · SUI/USDC · 20% fee' },
  2: { label: 'T2',       color: '#34d399', bg: 'rgba(52,211,153,0.1)',   description: '1,000 USDC limit · top 5 markets · 15% fee' },
  3: { label: 'T3',       color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',   description: '10,000 USDC limit · all markets · 10% fee' },
  4: { label: 'T4',       color: '#c084fc', bg: 'rgba(192,132,252,0.1)',  description: 'Unlimited · 0% fee · bonus multiplier' },
}

export interface AgentRow {
  address:           string
  endpoint:          string
  hasProfile:        boolean
  compositeScore:    number   // fraction 0..1
  tier:              number
  windowsCompleted:  number
  windowsAvailable:  number
  consecutiveMissed: number
  reputationFlag:    boolean
  scoreHistory:      number[] // fractions 0..1
}

interface ProfileResponse {
  compositeScore:    number
  windowsCompleted:  number
  windowsAvailable:  number
  consecutiveMissed: number
  scoreHistory:      number[]
  tier:              number
  reputationFlag:    boolean
}

/** All registered agents (from the registry) joined with their on-chain profile. */
export async function fetchAgentRows(workerUrl: string | undefined): Promise<AgentRow[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` },
    limit: 50,
    order: 'descending',
  })

  // De-dupe by agent (keep latest endpoint).
  const registered = new Map<string, string>()
  for (const e of events.data) {
    const f = e.parsedJson as { agent: string; endpoint: number[] }
    if (!registered.has(f.agent)) {
      registered.set(f.agent, new TextDecoder().decode(new Uint8Array(f.endpoint)))
    }
  }

  const rows = await Promise.all(
    Array.from(registered.entries()).map(async ([address, endpoint]): Promise<AgentRow> => {
      const base: AgentRow = {
        address, endpoint, hasProfile: false,
        compositeScore: 0, tier: 0, windowsCompleted: 0, windowsAvailable: 0,
        consecutiveMissed: 0, reputationFlag: false, scoreHistory: [],
      }
      if (!workerUrl) return base
      try {
        const res = await fetch(`${workerUrl}/agent/${address}/profile`)
        if (!res.ok) return base
        const p = await res.json() as ProfileResponse
        return {
          ...base,
          hasProfile:        true,
          compositeScore:    p.compositeScore / 10_000,
          tier:              p.tier,
          windowsCompleted:  p.windowsCompleted,
          windowsAvailable:  p.windowsAvailable,
          consecutiveMissed: p.consecutiveMissed,
          reputationFlag:    p.reputationFlag,
          scoreHistory:      (p.scoreHistory ?? []).map(s => s / 10_000),
        }
      } catch {
        return base
      }
    })
  )

  return rows.sort((a, b) => b.compositeScore - a.compositeScore)
}

/** Participation rate 0..1 — how often the agent commits to opened windows. */
export function participation(a: { windowsCompleted: number; windowsAvailable: number }): number {
  return a.windowsAvailable > 0 ? a.windowsCompleted / a.windowsAvailable : 0
}
