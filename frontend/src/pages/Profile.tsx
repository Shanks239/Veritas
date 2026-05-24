import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

const TIER_LABELS: Record<number, string> = {
  0: 'Unranked', 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4'
}
const TIER_COLORS: Record<number, string> = {
  0: 'bg-gray-800 text-gray-400',
  1: 'bg-blue-900 text-blue-300',
  2: 'bg-green-900 text-green-300',
  3: 'bg-yellow-900 text-yellow-300',
  4: 'bg-purple-900 text-purple-300',
}

interface ScorePoint { window: string; score: number }

async function fetchProfile(address: string) {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::agent_profile::ScoreUpdated` },
    limit: 50,
    order: 'ascending',
  })

  const relevant = events.data.filter(e => {
    const f = e.parsedJson as { profile_id: string }
    return f.profile_id === address
  })

  if (relevant.length === 0) return null

  const history: ScorePoint[] = relevant.map((e, i) => {
    const f = e.parsedJson as { composite_score: string }
    return {
      window: `W${i + 1}`,
      score:  Number(f.composite_score) / 100,
    }
  })

  const latest = relevant[relevant.length - 1].parsedJson as {
    composite_score: string
    new_tier: number
  }

  return {
    address,
    compositeScore: Number(latest.composite_score) / 10_000,
    tier:           latest.new_tier,
    windowsCompleted: relevant.length,
    history,
  }
}

export default function Profile() {
  const { address } = useParams<{ address: string }>()

  const { data, isLoading } = useQuery({
    queryKey:  ['profile', address],
    queryFn:   () => fetchProfile(address!),
    enabled:   !!address,
    refetchInterval: 30_000,
  })

  if (isLoading) return <div className="text-gray-400 text-sm">Loading profile...</div>
  if (!data) return (
    <div className="text-gray-400 text-sm">
      No score history found for this address.
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono">
            {data.address.slice(0, 8)}...{data.address.slice(-6)}
          </h1>
          <p className="text-gray-400 text-sm mt-1">{data.windowsCompleted} windows completed</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-sm font-medium ${TIER_COLORS[data.tier]}`}>
          {TIER_LABELS[data.tier]}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Composite Score', value: `${(data.compositeScore * 100).toFixed(1)}%` },
          { label: 'Tier', value: TIER_LABELS[data.tier] },
          { label: 'Windows', value: data.windowsCompleted },
        ].map(stat => (
          <div key={stat.label} className="rounded-xl border border-white/10 p-4">
            <div className="text-gray-400 text-xs mb-1">{stat.label}</div>
            <div className="text-xl font-bold">{stat.value}</div>
          </div>
        ))}
      </div>

      {data.history.length > 1 && (
        <div className="rounded-xl border border-white/10 p-4">
          <div className="text-sm text-gray-400 mb-4">Score history</div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data.history}>
              <XAxis dataKey="window" tick={{ fill: '#6b7280', fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fill: '#6b7280', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }}
                labelStyle={{ color: '#9ca3af' }}
              />
              <Line
                type="monotone"
                dataKey="score"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}