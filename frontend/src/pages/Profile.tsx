import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { TIER_CONFIG, participation, PACKAGE_ID } from '../lib/agents'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })

interface Profile {
  compositeScore:    number   // fraction 0..1
  tier:              number
  windowsCompleted:  number
  windowsAvailable:  number
  consecutiveMissed: number
  reputationFlag:    boolean
  scoreHistory:      number[] // fractions 0..1
}

interface ActivityItem {
  windowId:   string
  phase:      string
  prediction: { order?: { side: string; sizeUsdc: number; limitPrice: number } }
  score:      { composite: number; pnlUsd: number } | null
  opensAt:    number | null
}

interface AgentDetail {
  registered: boolean
  endpoint:   string | null
  profile:    Profile | null
  activity:   ActivityItem[]
}

async function fetchAgentDetail(address: string, workerUrl: string | undefined): Promise<AgentDetail> {
  const [profileRaw, activityRaw, regEvents] = await Promise.all([
    workerUrl ? fetch(`${workerUrl}/agent/${address}/profile`).then(r => r.ok ? r.json() : null).catch(() => null) : null,
    workerUrl ? fetch(`${workerUrl}/agent/${address}/activity`).then(r => r.ok ? r.json() : null).catch(() => null) : null,
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` }, limit: 50, order: 'descending' }),
  ])

  const reg = regEvents.data
    .map(e => e.parsedJson as { agent: string; endpoint: number[] })
    .find(f => f.agent === address)

  const profile: Profile | null = profileRaw ? {
    compositeScore:    profileRaw.compositeScore / 10_000,
    tier:              profileRaw.tier,
    windowsCompleted:  profileRaw.windowsCompleted,
    windowsAvailable:  profileRaw.windowsAvailable,
    consecutiveMissed: profileRaw.consecutiveMissed,
    reputationFlag:    profileRaw.reputationFlag,
    scoreHistory:      (profileRaw.scoreHistory ?? []).map((s: number) => s / 10_000),
  } : null

  return {
    registered: !!reg,
    endpoint:   reg ? new TextDecoder().decode(new Uint8Array(reg.endpoint)) : null,
    profile,
    activity:   (activityRaw?.activity ?? []) as ActivityItem[],
  }
}

/** Standard deviation of recent scores → a consistency read-out. */
function consistencyLabel(history: number[]): { label: string; color: string } {
  if (history.length < 3) return { label: 'Not enough data', color: 'rgba(255,255,255,0.4)' }
  const mean = history.reduce((a, b) => a + b, 0) / history.length
  const sd   = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length)
  if (sd < 0.02) return { label: 'Very steady', color: '#34d399' }
  if (sd < 0.05) return { label: 'Steady',      color: '#60a5fa' }
  if (sd < 0.10) return { label: 'Variable',    color: '#fbbf24' }
  return { label: 'Volatile', color: '#f87171' }
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#111', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '8px 12px', fontSize: '0.75rem' }}>
      <div style={{ color: 'rgba(255,255,255,0.4)', marginBottom: '2px' }}>{label}</div>
      <div style={{ color: '#c084fc', fontFamily: '"DM Mono", monospace' }}>{payload[0].value.toFixed(1)}%</div>
    </div>
  )
}

const card: React.CSSProperties = {
  padding: '16px 20px',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: '10px',
  background: 'rgba(255,255,255,0.02)',
}

export default function Profile() {
  const { address } = useParams<{ address: string }>()
  const workerUrl = import.meta.env.VITE_WORKER_URL
  const { data, isLoading } = useQuery({
    queryKey: ['agent-detail', address, workerUrl],
    queryFn: () => fetchAgentDetail(address!, workerUrl),
    enabled: !!address,
    refetchInterval: 30_000,
  })

  if (isLoading) return (
    <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.875rem', padding: '3rem 0' }}>Loading profile...</div>
  )

  const tier    = TIER_CONFIG[data?.profile?.tier ?? 0] ?? TIER_CONFIG[0]
  const profile = data?.profile
  const uptime  = profile ? participation(profile) : 0
  const consistency = consistencyLabel(profile?.scoreHistory ?? [])
  const chart   = (profile?.scoreHistory ?? []).map((s, i) => ({ window: `W${i + 1}`, score: s * 100 }))
  const scored  = (data?.activity ?? []).filter(a => a.score)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 0.5rem', color: '#fff' }}>
            Agent Profile
          </h2>
          <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', wordBreak: 'break-all' }}>
            {address}
          </div>
          {data?.endpoint && (
            <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.75rem', color: 'rgba(255,255,255,0.25)', marginTop: '4px' }}>
              {data.endpoint}
            </div>
          )}
        </div>
        <div style={{ padding: '8px 18px', borderRadius: '8px', background: tier.bg, border: `1px solid ${tier.color}30`, textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 500, color: tier.color, letterSpacing: '0.02em' }}>{tier.label}</div>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', marginTop: '2px', maxWidth: '200px' }}>{tier.description}</div>
        </div>
      </div>

      {/* Not registered / no profile notices */}
      {data && !data.registered && (
        <div style={{ padding: '14px 16px', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '8px', background: 'rgba(248,113,113,0.05)', fontSize: '0.8125rem', color: '#f87171' }}>
          This address is not a registered agent — it cannot accept delegation.
        </div>
      )}
      {data?.registered && !profile && (
        <div style={{ padding: '14px 16px', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '8px', background: 'rgba(251,191,36,0.05)', fontSize: '0.8125rem', color: 'rgba(251,191,36,0.85)' }}>
          Registered, but no scored windows yet — no track record to evaluate.
        </div>
      )}
      {profile?.reputationFlag && (
        <div style={{ padding: '14px 16px', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '8px', background: 'rgba(248,113,113,0.05)', fontSize: '0.8125rem', color: '#f87171' }}>
          ⚠ Reputation flagged for inactivity — score has decayed from missed windows.
        </div>
      )}

      {/* Key stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        {[
          { label: 'Composite Score', value: profile ? `${(profile.compositeScore * 100).toFixed(1)}%` : '—', mono: true, color: '#fff' },
          { label: 'Uptime', value: profile && profile.windowsAvailable > 0 ? `${(uptime * 100).toFixed(0)}%` : '—', mono: true, color: uptime >= 0.7 ? '#34d399' : uptime > 0 ? '#fbbf24' : '#fff', sub: profile ? `${profile.windowsCompleted}/${profile.windowsAvailable} windows` : undefined },
          { label: 'Consistency', value: consistency.label, mono: false, color: consistency.color },
          { label: 'Consecutive Missed', value: profile ? String(profile.consecutiveMissed) : '—', mono: true, color: (profile?.consecutiveMissed ?? 0) >= 3 ? '#f87171' : '#fff' },
        ].map(s => (
          <div key={s.label} style={card}>
            <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' }}>{s.label}</div>
            <div style={{ fontSize: '1.4rem', fontFamily: s.mono ? '"DM Mono", monospace' : 'inherit', fontWeight: 500, color: s.color }}>{s.value}</div>
            {s.sub && <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', marginTop: '4px', fontFamily: '"DM Mono", monospace' }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Delegate CTA */}
      {data?.registered && (
        <Link
          to={`/delegate?agent=${address}`}
          style={{
            textDecoration: 'none', textAlign: 'center', padding: '13px',
            borderRadius: '10px', background: '#7c3aed', color: '#fff',
            fontSize: '0.9rem', fontWeight: 500,
          }}
        >
          Delegate stake to this agent →
        </Link>
      )}

      {/* Score history */}
      {chart.length > 1 && (
        <div style={card}>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '16px' }}>
            Score History
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chart}>
              <XAxis dataKey="window" tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="score" stroke="#c084fc" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent predictions */}
      {scored.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Recent Predictions
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {scored.slice(0, 8).map(a => (
              <div key={a.windowId} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', alignItems: 'center', gap: '12px', fontSize: '0.8125rem' }}>
                <span style={{ fontFamily: '"DM Mono", monospace', color: 'rgba(255,255,255,0.4)' }}>
                  {a.windowId.slice(0, 8)}…
                </span>
                {a.prediction?.order ? (
                  <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.75rem' }}>
                    <span style={{ color: a.prediction.order.side === 'bid' ? '#34d399' : '#f87171', textTransform: 'uppercase' }}>{a.prediction.order.side}</span>
                    <span style={{ color: 'rgba(255,255,255,0.4)' }}> {(a.prediction.order.sizeUsdc / 1e6).toFixed(0)}</span>
                  </span>
                ) : <span />}
                <span style={{ fontFamily: '"DM Mono", monospace', color: (a.score!.pnlUsd ?? 0) >= 0 ? '#34d399' : '#f87171' }}>
                  {(a.score!.pnlUsd ?? 0) >= 0 ? '+' : ''}{(a.score!.pnlUsd ?? 0).toFixed(2)}
                </span>
                <span style={{ fontFamily: '"DM Mono", monospace', color: '#fff' }}>
                  {(a.score!.composite * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '12px', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '0.625rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)' }}>
            <span>Window</span><span>Order</span><span>PnL $</span><span>Score</span>
          </div>
        </div>
      )}
    </div>
  )
}
