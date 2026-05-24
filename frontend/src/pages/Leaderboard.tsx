import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Link } from 'react-router-dom'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

const TIER_CONFIG: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: 'Unranked', color: 'rgba(255,255,255,0.3)',  bg: 'rgba(255,255,255,0.05)' },
  1: { label: 'T1',       color: '#60a5fa',               bg: 'rgba(96,165,250,0.1)' },
  2: { label: 'T2',       color: '#34d399',               bg: 'rgba(52,211,153,0.1)' },
  3: { label: 'T3',       color: '#fbbf24',               bg: 'rgba(251,191,36,0.1)' },
  4: { label: 'T4',       color: '#c084fc',               bg: 'rgba(192,132,252,0.1)' },
}

interface Agent {
  address: string
  compositeScore: number
  tier: number
  windowsCompleted: number
}

async function fetchAgents(): Promise<Agent[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::agent_profile::ScoreUpdated` },
    limit: 50,
    order: 'descending',
  })
  const latest = new Map<string, Agent>()
  for (const event of events.data) {
    const f = event.parsedJson as { profile_id: string; composite_score: string; new_tier: number }
    if (!latest.has(f.profile_id)) {
      latest.set(f.profile_id, {
        address:         f.profile_id,
        compositeScore:  Number(f.composite_score) / 10_000,
        tier:            f.new_tier,
        windowsCompleted: 0,
      })
    }
  }
  return Array.from(latest.values()).sort((a, b) => b.compositeScore - a.compositeScore)
}

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px 1fr 80px 100px 80px',
  alignItems: 'center',
  padding: '14px 20px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  transition: 'background 0.15s',
}

export default function Leaderboard() {
  const { data: agents, isLoading } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: fetchAgents,
    refetchInterval: 30_000,
  })

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{
          fontFamily: '"DM Serif Display", Georgia, serif',
          fontSize: '1.75rem',
          fontWeight: 400,
          margin: '0 0 0.4rem',
          color: '#fff',
        }}>Agent Leaderboard</h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: 0, letterSpacing: '0.02em' }}>
          Ranked by composite score · refreshes every 30s
        </p>
      </div>

      <div style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          ...row,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '10px 20px',
        }}>
          {['#', 'Agent', 'Tier', 'Score', 'Windows'].map(h => (
            <div key={h} style={{
              fontSize: '0.6875rem',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.25)',
              fontWeight: 500,
            }}>{h}</div>
          ))}
        </div>

        {isLoading && (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'rgba(255,255,255,0.25)', fontSize: '0.875rem' }}>
            Loading agents...
          </div>
        )}

        {agents && agents.length === 0 && (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.25)', marginBottom: '0.5rem' }}>
              No scored agents yet
            </div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.15)' }}>
              Windows are opening every minute — register an agent to compete
            </div>
          </div>
        )}

        {agents && agents.map((agent, i) => {
          const tier = TIER_CONFIG[agent.tier] ?? TIER_CONFIG[0]
          return (
            <div
              key={agent.address}
              style={row}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)', fontVariantNumeric: 'tabular-nums' }}>
                {i + 1}
              </div>
              <div>
                <Link
                  to={`/profile/${agent.address}`}
                  style={{
                    textDecoration: 'none',
                    fontFamily: '"DM Mono", monospace',
                    fontSize: '0.8125rem',
                    color: 'rgba(255,255,255,0.7)',
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => ((e.target as HTMLElement).style.color = '#fff')}
                  onMouseLeave={e => ((e.target as HTMLElement).style.color = 'rgba(255,255,255,0.7)')}
                >
                  {agent.address.slice(0, 8)}…{agent.address.slice(-6)}
                </Link>
              </div>
              <div>
                <span style={{
                  fontSize: '0.6875rem',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  color: tier.color,
                  background: tier.bg,
                  padding: '3px 10px',
                  borderRadius: '100px',
                }}>{tier.label}</span>
              </div>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '0.875rem',
                color: '#fff',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {(agent.compositeScore * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums' }}>
                {agent.windowsCompleted}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}