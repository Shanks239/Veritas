import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { useEffect, useState } from 'react'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

interface WindowData {
  id: string
  opensAt: number
  closesAt: number
  resolvesAt: number
  commitCount: number
  resolved: boolean
}

interface CommitDetail {
  agentAddress: string
  commitId: string
  hash: string
  order: { side: string; sizeUsdc: number; limitPrice: number } | null
}

function Countdown({ target, dim }: { target: number; dim?: boolean }) {
  const [remaining, setRemaining] = useState(target - Date.now())
  useEffect(() => {
    const interval = setInterval(() => setRemaining(target - Date.now()), 1000)
    return () => clearInterval(interval)
  }, [target])

  if (remaining <= 0) return (
    <span style={{ color: 'rgba(255,255,255,0.2)', fontFamily: '"DM Mono", monospace', fontSize: '0.875rem' }}>
      Elapsed
    </span>
  )

  const secs  = Math.floor(remaining / 1000)
  const mins  = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)

  return (
    <span style={{
      fontFamily: '"DM Mono", monospace',
      fontSize: '0.875rem',
      color: dim ? 'rgba(255,255,255,0.4)' : '#fff',
    }}>
      {hours > 0 && `${hours}h `}
      {String(mins % 60).padStart(2, '0')}m{' '}
      {String(secs % 60).padStart(2, '0')}s
    </span>
  )
}

const PHASES: Record<string, { label: string; color: string; dot: string }> = {
  deliberating:     { label: 'Deliberating',     color: '#60a5fa', dot: '#3b82f6' },
  awaiting_horizon: { label: 'Awaiting horizon', color: '#fbbf24', dot: '#f59e0b' },
  resolvable:       { label: 'Resolvable',       color: '#34d399', dot: '#10b981' },
  resolved:         { label: 'Resolved',         color: 'rgba(255,255,255,0.2)', dot: 'rgba(255,255,255,0.15)' },
}

function getPhase(w: WindowData): string {
  const now = Date.now()
  if (now < w.closesAt)   return 'deliberating'
  if (now < w.resolvesAt) return 'awaiting_horizon'
  if (!w.resolved)        return 'resolvable'
  return 'resolved'
}

async function fetchWindows(): Promise<WindowData[]> {
  const [opened, resolved] = await Promise.all([
    client.queryEvents({
      query: { MoveEventType: `${PACKAGE_ID}::window::WindowOpened` },
      limit: 20,
      order: 'descending',
    }),
    client.queryEvents({
      query: { MoveEventType: `${PACKAGE_ID}::window::WindowResolved` },
      limit: 50,
      order: 'descending',
    }),
  ])

  const resolvedIds = new Set(
    resolved.data.map(e => (e.parsedJson as { window_id: string }).window_id)
  )

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

export default function Windows() {
  const { data: windows, isLoading } = useQuery({
    queryKey: ['windows'],
    queryFn: fetchWindows,
    refetchInterval: 10_000,
  })

  const workerUrl = import.meta.env.VITE_WORKER_URL
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: commitCounts } = useQuery<Record<string, number>>({
    queryKey: ['window-commits', windows?.map(w => w.id)],
    queryFn: async () => {
      const results = await Promise.all(
        (windows ?? []).map(w =>
          fetch(`${workerUrl}/window/${w.id}/stats`)
            .then(r => r.json() as Promise<{ commitCount: number }>)
            .then(s => [w.id, s.commitCount] as const)
            .catch(() => [w.id, 0] as const)
        )
      )
      return Object.fromEntries(results)
    },
    enabled: !!windows && !!workerUrl,
    refetchInterval: 15_000,
  })

  // Lazy: only the expanded window's per-agent commit detail is fetched.
  const { data: expandedCommits, isLoading: commitsLoading } = useQuery<CommitDetail[]>({
    queryKey: ['window-commit-detail', expanded],
    queryFn: async () => {
      const r = await fetch(`${workerUrl}/window/${expanded}/commits`)
      const j = await r.json() as { commits: CommitDetail[] }
      return j.commits ?? []
    },
    enabled: !!expanded && !!workerUrl,
    refetchInterval: 10_000,
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
        }}>Prediction Windows</h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: 0 }}>
          Active session 12:00–22:00 UTC: a window every ~10 min · hourly overnight · 5 min to commit
        </p>
      </div>

      {isLoading && (
        <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.875rem', padding: '2rem 0' }}>
          Loading windows...
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {windows?.map(w => {
          const phase = getPhase(w)
          const p = PHASES[phase]
          const isActive = phase === 'deliberating' || phase === 'awaiting_horizon'

          return (
            <div key={w.id} style={{
              border: `1px solid ${isActive ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)'}`,
              borderRadius: '10px',
              padding: '16px 20px',
              background: isActive ? 'rgba(255,255,255,0.02)' : 'transparent',
              transition: 'border-color 0.2s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{
                    width: '6px', height: '6px', borderRadius: '50%',
                    background: p.dot,
                    boxShadow: isActive ? `0 0 6px ${p.dot}` : 'none',
                  }} />
                  <span style={{
                    fontFamily: '"DM Mono", monospace',
                    fontSize: '0.75rem',
                    color: 'rgba(255,255,255,0.3)',
                  }}>
                    {w.id.slice(0, 10)}…{w.id.slice(-6)}
                  </span>
                </div>
                <span style={{
                  fontSize: '0.6875rem',
                  fontWeight: 500,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: p.color,
                }}>{p.label}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                {[
                  { label: 'Closes in', value: <Countdown target={w.closesAt} dim={phase !== 'deliberating'} /> },
                  { label: 'Resolves in', value: <Countdown target={w.resolvesAt} /> },
                ].map(stat => (
                  <div key={stat.label}>
                    <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
                      {stat.label}
                    </div>
                    {stat.value}
                  </div>
                ))}
                {(() => {
                  const count = commitCounts?.[w.id] ?? w.commitCount
                  const isOpen = expanded === w.id
                  return (
                    <div>
                      <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>
                        Commits
                      </div>
                      <button
                        onClick={() => setExpanded(isOpen ? null : w.id)}
                        disabled={count === 0}
                        style={{
                          background: 'none', border: 'none', padding: 0,
                          fontFamily: '"DM Mono", monospace', fontSize: '0.875rem',
                          color: count === 0 ? 'rgba(255,255,255,0.4)' : '#60a5fa',
                          cursor: count === 0 ? 'default' : 'pointer',
                          display: 'flex', alignItems: 'center', gap: '5px',
                        }}
                      >
                        {count}
                        {count > 0 && (
                          <span style={{ fontSize: '0.7rem', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                        )}
                      </button>
                    </div>
                  )
                })()}
              </div>

              {expanded === w.id && (
                <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {commitsLoading && (
                    <span style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)' }}>Loading commits…</span>
                  )}
                  {!commitsLoading && (expandedCommits?.length ?? 0) === 0 && (
                    <span style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)' }}>No commits recorded yet.</span>
                  )}
                  {expandedCommits?.map(c => (
                    <div key={c.agentAddress} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                      <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.7)' }}>
                        {c.agentAddress.slice(0, 10)}…{c.agentAddress.slice(-6)}
                      </span>
                      {c.order && (
                        <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.75rem' }}>
                          <span style={{ color: c.order.side === 'bid' ? '#34d399' : '#f87171', textTransform: 'uppercase' }}>{c.order.side}</span>
                          <span style={{ color: 'rgba(255,255,255,0.4)' }}> {(c.order.sizeUsdc / 1e6).toFixed(0)} USDC @ {(c.order.limitPrice / 1e6).toFixed(4)}</span>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}