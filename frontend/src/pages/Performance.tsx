import { useQuery } from '@tanstack/react-query'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'

const label: React.CSSProperties = {
  fontSize: '0.6875rem',
  color: 'rgba(255,255,255,0.35)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: '8px',
}

const card: React.CSSProperties = {
  padding: '16px 20px',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: '10px',
  background: 'rgba(255,255,255,0.02)',
}

const TIER_NAMES = ['Unranked', 'Tier 1', 'Tier 2', 'Tier 3', 'Tier 4']
const TIER_COLORS = ['rgba(255,255,255,0.35)', '#60a5fa', '#34d399', '#c084fc', '#fbbf24']

interface ProfileData {
  profileId: string
  compositeScore: number    // scaled 0–10000
  windowsCompleted: number
  windowsAvailable: number
  consecutiveMissed: number
  scoreHistory: number[]    // scaled 0–10000
  tier: number
  reputationFlag: boolean
}

interface ActivityItem {
  windowId: string
  opensAt: number | null
  phase: string
  prediction: { order: { side: string; sizeUsdc: number; limitPrice: number } }
  score: {
    composite: number
    pnlUsd?: number
    entryPrice: number
    outcomePrice: number
  } | null
}

const usd = (scaled: number) => `$${(scaled / 1e6).toFixed(4)}`

/**
 * Performance panel rendered inside the My Agent page (Performance tab).
 * Assumes a wallet is already connected — the parent page handles the guard.
 */
export default function Performance() {
  const { primaryWallet } = useDynamicContext()
  const walletAddress = primaryWallet ? (primaryWallet as unknown as { address: string }).address : null
  const workerUrl = import.meta.env.VITE_WORKER_URL

  const { data: profile, isLoading: profileLoading } = useQuery<ProfileData | null>({
    queryKey: ['agent-profile', walletAddress],
    queryFn: async () => {
      const res = await fetch(`${workerUrl}/agent/${walletAddress}/profile`)
      if (!res.ok) return null
      return res.json() as Promise<ProfileData>
    },
    enabled: !!walletAddress && !!workerUrl,
    refetchInterval: 30_000,
  })

  const { data: activity } = useQuery<ActivityItem[]>({
    queryKey: ['my-agent-activity', walletAddress],
    queryFn: async () => {
      const res = await fetch(`${workerUrl}/agent/${walletAddress}/activity`)
      const data = await res.json() as { activity: ActivityItem[] }
      return data.activity
    },
    enabled: !!walletAddress && !!workerUrl,
    refetchInterval: 15_000,
  })

  if (!primaryWallet) return null

  const scored = (activity ?? []).filter(a => a.score)
  const totalPnl = scored.reduce((s, a) => s + (a.score?.pnlUsd ?? 0), 0)
  const tier = profile?.tier ?? 0
  const participation = profile && profile.windowsAvailable > 0
    ? (profile.windowsCompleted / profile.windowsAvailable) * 100
    : null

  // Cumulative PnL rows, oldest first so the running total reads naturally
  let running = 0
  const pnlRows = [...scored].reverse().map(a => {
    running += a.score?.pnlUsd ?? 0
    return { ...a, cumulative: running }
  }).reverse()

  const history = profile?.scoreHistory ?? []
  const maxBar = 10000

  return (
    <div>
      {profileLoading ? (
        <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)' }}>Loading…</div>
      ) : !profile ? (
        <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)' }}>
          No on-chain profile yet — it is created automatically after your agent's first scored window.
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '2rem' }}>
            <div style={card}>
              <div style={{ ...label, marginBottom: '6px' }}>Tier</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 500, color: TIER_COLORS[tier] ?? TIER_COLORS[0] }}>
                {TIER_NAMES[tier] ?? `Tier ${tier}`}
              </div>
            </div>
            <div style={card}>
              <div style={{ ...label, marginBottom: '6px' }}>Composite Score</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 500, color: '#c084fc', fontFamily: '"DM Mono", monospace' }}>
                {(profile.compositeScore / 10000).toFixed(4)}
              </div>
            </div>
            <div style={card}>
              <div style={{ ...label, marginBottom: '6px' }}>Windows Scored</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 500, color: '#fff', fontFamily: '"DM Mono", monospace' }}>
                {profile.windowsCompleted}
                {participation !== null && (
                  <span style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', marginLeft: '6px' }}>
                    {participation.toFixed(0)}% rate
                  </span>
                )}
              </div>
            </div>
            <div style={card}>
              <div style={{ ...label, marginBottom: '6px' }}>Simulated PnL</div>
              <div style={{
                fontSize: '1.25rem', fontWeight: 500, fontFamily: '"DM Mono", monospace',
                color: totalPnl >= 0 ? '#34d399' : '#f87171',
              }}>
                {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)} <span style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)' }}>USDC</span>
              </div>
            </div>
          </div>

          {/* Score history */}
          <div style={{ marginBottom: '2rem' }}>
            <span style={label}>Score History (last {history.length} windows)</span>
            {history.length === 0 ? (
              <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.2)' }}>No scored windows yet</div>
            ) : (
              <div style={{ ...card, padding: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '90px' }}>
                  {history.map((s, i) => (
                    <div
                      key={i}
                      title={(s / 10000).toFixed(4)}
                      style={{
                        flex: 1,
                        maxWidth: '32px',
                        height: `${Math.max((s / maxBar) * 100, 2)}%`,
                        background: s >= 5000 ? 'rgba(52,211,153,0.55)' : 'rgba(248,113,113,0.55)',
                        borderRadius: '3px 3px 0 0',
                      }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '0.625rem', color: 'rgba(255,255,255,0.2)' }}>
                  <span>oldest</span>
                  <span>0.5 = neutral · bar height = composite</span>
                  <span>latest</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Per-window gains */}
      <div>
        <span style={label}>Prediction Gains ({pnlRows.length})</span>
        {pnlRows.length === 0 ? (
          <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.2)' }}>
            No resolved predictions with recorded gains yet — resolved windows appear here after each horizon
          </div>
        ) : (
          <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', overflow: 'hidden' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr 1fr',
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              fontSize: '0.6875rem', color: 'rgba(255,255,255,0.2)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
              <div>Window</div><div>Side</div><div>Entry → Outcome</div><div>PnL</div><div>Cumulative</div>
            </div>
            {pnlRows.map((row, i) => {
              const pnl = row.score?.pnlUsd ?? 0
              return (
                <div key={row.windowId} style={{
                  display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr 1fr 1fr',
                  padding: '11px 16px',
                  borderBottom: i < pnlRows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  alignItems: 'center',
                  fontSize: '0.8125rem',
                  fontFamily: '"DM Mono", monospace',
                }}>
                  <a
                    href={`https://suiscan.xyz/testnet/object/${row.windowId}`}
                    target="_blank" rel="noreferrer"
                    style={{ color: 'rgba(255,255,255,0.5)', textDecoration: 'none' }}
                  >
                    {row.windowId.slice(0, 8)}…{row.windowId.slice(-4)}
                  </a>
                  <div style={{ color: row.prediction.order.side === 'bid' ? '#34d399' : '#f87171' }}>
                    {row.prediction.order.side.toUpperCase()}
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.5)' }}>
                    {row.score ? `${usd(row.score.entryPrice)} → ${usd(row.score.outcomePrice)}` : '—'}
                  </div>
                  <div style={{ color: pnl >= 0 ? '#34d399' : '#f87171' }}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                  </div>
                  <div style={{ color: row.cumulative >= 0 ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)' }}>
                    {row.cumulative >= 0 ? '+' : ''}{row.cumulative.toFixed(2)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
