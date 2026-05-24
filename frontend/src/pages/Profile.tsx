import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

const TIER_CONFIG: Record<number, { label: string; color: string; bg: string; description: string }> = {
  0: { label: 'Unranked', color: 'rgba(255,255,255,0.3)', bg: 'rgba(255,255,255,0.05)', description: 'Complete 10 windows to earn a tier' },
  1: { label: 'T1',       color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',   description: '100 USDC position limit · SUI/USDC only' },
  2: { label: 'T2',       color: '#34d399', bg: 'rgba(52,211,153,0.1)',   description: '1,000 USDC limit · top 5 markets' },
  3: { label: 'T3',       color: '#fbbf24', bg: 'rgba(251,191,36,0.1)',   description: '10,000 USDC limit · all markets' },
  4: { label: 'T4',       color: '#c084fc', bg: 'rgba(192,132,252,0.1)',  description: 'Unlimited · 0% fee · bonus multiplier' },
}

interface ScorePoint { window: string; score: number }

async function fetchProfile(address: string) {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::agent_profile::ScoreUpdated` },
    limit: 50,
    order: 'ascending',
  })
  const relevant = events.data.filter(e => (e.parsedJson as { profile_id: string }).profile_id === address)
  if (relevant.length === 0) return null

  const history: ScorePoint[] = relevant.map((e, i) => ({
    window: `W${i + 1}`,
    score:  Number((e.parsedJson as { composite_score: string }).composite_score) / 100,
  }))
  const latest = relevant[relevant.length - 1].parsedJson as { composite_score: string; new_tier: number }
  return {
    address,
    compositeScore: Number(latest.composite_score) / 10_000,
    tier: latest.new_tier,
    windowsCompleted: relevant.length,
    history,
  }
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#111',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '8px',
      padding: '8px 12px',
      fontSize: '0.75rem',
    }}>
      <div style={{ color: 'rgba(255,255,255,0.4)', marginBottom: '2px' }}>{label}</div>
      <div style={{ color: '#c084fc', fontFamily: '"DM Mono", monospace' }}>
        {payload[0].value.toFixed(1)}%
      </div>
    </div>
  )
}

export default function Profile() {
  const { address } = useParams<{ address: string }>()
  const { data, isLoading } = useQuery({
    queryKey: ['profile', address],
    queryFn: () => fetchProfile(address!),
    enabled: !!address,
    refetchInterval: 30_000,
  })

  if (isLoading) return (
    <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.875rem', padding: '3rem 0' }}>
      Loading profile...
    </div>
  )

  if (!data) return (
    <div style={{ padding: '3rem 0' }}>
      <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.25)' }}>No score history found for this agent.</div>
      <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.15)', marginTop: '0.5rem' }}>
        {address?.slice(0, 10)}…{address?.slice(-6)}
      </div>
    </div>
  )

  const tier = TIER_CONFIG[data.tier] ?? TIER_CONFIG[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{
            fontFamily: '"DM Serif Display", Georgia, serif',
            fontSize: '1.75rem',
            fontWeight: 400,
            margin: '0 0 0.5rem',
            color: '#fff',
          }}>Agent Profile</h2>
          <div style={{
            fontFamily: '"DM Mono", monospace',
            fontSize: '0.8125rem',
            color: 'rgba(255,255,255,0.35)',
          }}>
            {data.address.slice(0, 10)}…{data.address.slice(-8)}
          </div>
        </div>
        <div style={{
          padding: '8px 18px',
          borderRadius: '8px',
          background: tier.bg,
          border: `1px solid ${tier.color}30`,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 500, color: tier.color, letterSpacing: '0.02em' }}>
            {tier.label}
          </div>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>
            {tier.description}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
        {[
          { label: 'Composite Score', value: `${(data.compositeScore * 100).toFixed(1)}%`, mono: true },
          { label: 'Windows Completed', value: data.windowsCompleted, mono: false },
          { label: 'Current Tier', value: tier.label, mono: false, color: tier.color },
        ].map(stat => (
          <div key={stat.label} style={{
            padding: '16px 20px',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '10px',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '8px' }}>
              {stat.label}
            </div>
            <div style={{
              fontSize: '1.5rem',
              fontFamily: stat.mono ? '"DM Mono", monospace' : 'inherit',
              fontWeight: 500,
              color: stat.color || '#fff',
            }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* Chart */}
      {data.history.length > 1 && (
        <div style={{
          padding: '20px',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.02)',
        }}>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '16px' }}>
            Score History
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data.history}>
              <XAxis dataKey="window" tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: 'rgba(255,255,255,0.2)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="score" stroke="#c084fc" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}