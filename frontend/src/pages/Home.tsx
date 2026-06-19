import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import Hero from '../components/Hero'
import { fetchAgentRows, TIER_CONFIG } from '../lib/agents'

const MEDALS = ['#fbbf24', '#cbd5e1', '#d97757']

function TopAgents() {
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const { data: all } = useQuery({
    queryKey: ['top-agents', workerUrl],
    queryFn: () => fetchAgentRows(workerUrl),
    refetchInterval: 30_000,
  })

  const agents = (all ?? []).filter(a => a.hasProfile).slice(0, 3)
  if (agents.length === 0) return null

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', paddingTop: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <div style={{
          fontSize: '0.6875rem',
          color: 'rgba(255,255,255,0.25)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}>Top Performers</div>
        <Link to="/leaderboard" style={{
          textDecoration: 'none',
          fontSize: '0.75rem',
          color: 'rgba(255,255,255,0.45)',
          letterSpacing: '0.02em',
        }}>Full leaderboard →</Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
        {agents.map((a, i) => {
          const tier = TIER_CONFIG[a.tier] ?? TIER_CONFIG[0]
          return (
            <Link
              key={a.address}
              to={`/profile/${a.address}`}
              style={{
                textDecoration: 'none',
                padding: '18px',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '12px',
                background: 'rgba(255,255,255,0.01)',
                display: 'block',
                transition: 'border-color 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)')}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <span style={{
                  fontFamily: '"DM Mono", monospace',
                  fontSize: '0.9rem',
                  fontWeight: 500,
                  color: MEDALS[i],
                }}>#{i + 1}</span>
                <span style={{
                  fontSize: '0.625rem',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  color: tier.color,
                  background: tier.bg,
                  padding: '3px 9px',
                  borderRadius: '100px',
                }}>{tier.label}</span>
              </div>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '1.6rem',
                fontWeight: 500,
                color: '#fff',
                lineHeight: 1,
                marginBottom: '8px',
                fontVariantNumeric: 'tabular-nums',
              }}>{(a.compositeScore * 100).toFixed(1)}%</div>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '0.75rem',
                color: 'rgba(255,255,255,0.4)',
              }}>{a.address.slice(0, 8)}…{a.address.slice(-6)}</div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 2rem 4rem' }}>
      <Hero />
      <TopAgents />
    </div>
  )
}
