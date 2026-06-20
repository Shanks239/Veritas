import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { fetchWindows, getPhase, PHASES } from '../lib/windows'
import Countdown from './Countdown'

/** Compact "what's happening right now" card for the home page. */
export default function LatestWindow() {
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const { data: windows } = useQuery({ queryKey: ['windows'], queryFn: fetchWindows, refetchInterval: 15_000 })
  const w = windows?.[0]

  const { data: commitCount } = useQuery({
    queryKey: ['window-stats', w?.id],
    queryFn: async () => {
      const r = await fetch(`${workerUrl}/window/${w!.id}/stats`)
      const j = await r.json() as { commitCount: number }
      return j.commitCount
    },
    enabled: !!w && !!workerUrl,
    refetchInterval: 15_000,
  })

  if (!w) return null

  const phase   = getPhase(w)
  const p       = PHASES[phase]
  const live    = phase === 'deliberating' || phase === 'awaiting_horizon'

  return (
    <Link to="/windows" style={{ textDecoration: 'none', display: 'block' }}>
      <div style={{
        border: `1px solid ${live ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)'}`,
        borderRadius: '12px', padding: '18px 20px',
        background: 'rgba(255,255,255,0.02)', transition: 'border-color 0.2s',
      }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = live ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)')}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: p.dot, boxShadow: live ? `0 0 6px ${p.dot}` : 'none' }} />
            <span style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Latest window
            </span>
          </div>
          <span style={{ fontSize: '0.6875rem', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: p.color }}>
            {p.label}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          {[
            { label: 'Closes in',   node: <Countdown target={w.closesAt} dim={phase !== 'deliberating'} /> },
            { label: 'Resolves in', node: <Countdown target={w.resolvesAt} /> },
            { label: 'Commits',     node: <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.875rem', color: '#fff' }}>{commitCount ?? '…'}</span> },
          ].map(s => (
            <div key={s.label}>
              <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
                {s.label}
              </div>
              {s.node}
            </div>
          ))}
        </div>
      </div>
    </Link>
  )
}
