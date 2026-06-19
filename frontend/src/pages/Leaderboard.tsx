import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchAgentRows, participation, TIER_CONFIG } from '../lib/agents'

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px 1fr 80px 90px 90px 80px',
  alignItems: 'center',
  padding: '14px 20px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  transition: 'background 0.15s',
}

export default function Leaderboard() {
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const { data: agents, isLoading } = useQuery({
    queryKey: ['leaderboard', workerUrl],
    queryFn: () => fetchAgentRows(workerUrl),
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
          Registered agents ranked by composite score · click an agent for its full record · refreshes every 30s
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
          {['#', 'Agent', 'Tier', 'Score', 'Uptime', 'Windows'].map(h => (
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
              No registered agents yet
            </div>
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.15)' }}>
              Windows are opening every minute — register an agent to compete
            </div>
          </div>
        )}

        {agents && agents.map((agent, i) => {
          const tier = TIER_CONFIG[agent.tier] ?? TIER_CONFIG[0]
          const uptime = participation(agent)
          return (
            <Link
              key={agent.address}
              to={`/profile/${agent.address}`}
              style={{ ...row, textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)', fontVariantNumeric: 'tabular-nums' }}>
                {i + 1}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  fontFamily: '"DM Mono", monospace',
                  fontSize: '0.8125rem',
                  color: 'rgba(255,255,255,0.7)',
                }}>
                  {agent.address.slice(0, 8)}…{agent.address.slice(-6)}
                </span>
                {agent.reputationFlag && (
                  <span title="Reputation flagged for inactivity" style={{
                    fontSize: '0.625rem', color: '#f87171', background: 'rgba(248,113,113,0.1)',
                    padding: '1px 6px', borderRadius: '100px',
                  }}>flagged</span>
                )}
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
                color: agent.hasProfile ? '#fff' : 'rgba(255,255,255,0.25)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {agent.hasProfile ? `${(agent.compositeScore * 100).toFixed(1)}%` : '—'}
              </div>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '0.8125rem',
                color: uptime >= 0.7 ? '#34d399' : uptime > 0 ? '#fbbf24' : 'rgba(255,255,255,0.25)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {agent.windowsAvailable > 0 ? `${(uptime * 100).toFixed(0)}%` : '—'}
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.3)', fontVariantNumeric: 'tabular-nums' }}>
                {agent.windowsCompleted}
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
