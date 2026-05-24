import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Link } from 'react-router-dom'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })

const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

const TIER_LABELS: Record<number, string> = {
  0: 'Unranked', 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4'
}

const TIER_COLORS: Record<number, string> = {
  0: 'text-gray-500',
  1: 'text-blue-400',
  2: 'text-green-400',
  3: 'text-yellow-400',
  4: 'text-purple-400',
}

interface Agent {
  address: string
  compositeScore: number
  tier: number
  windowsCompleted: number
  participationRate: number
  reputationFlag: boolean
}

async function fetchAgents(): Promise<Agent[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::agent_profile::ScoreUpdated` },
    limit: 50,
    order: 'descending',
  })

  // Deduplicate by profile_id, keep latest score per agent
  const latest = new Map<string, Agent>()

  for (const event of events.data) {
    const f = event.parsedJson as {
      profile_id: string
      window_id: string
      composite_score: string
      new_tier: number
    }
    if (!latest.has(f.profile_id)) {
      latest.set(f.profile_id, {
        address:          f.profile_id,
        compositeScore:   Number(f.composite_score) / 10_000,
        tier:             f.new_tier,
        windowsCompleted: 0,
        participationRate: 0,
        reputationFlag:   false,
      })
    }
  }

  return Array.from(latest.values())
    .sort((a, b) => b.compositeScore - a.compositeScore)
}

export default function Leaderboard() {
  const { data: agents, isLoading, error } = useQuery({
    queryKey: ['leaderboard'],
    queryFn:  fetchAgents,
    refetchInterval: 30_000, // refresh every 30s
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <p className="text-gray-400 text-sm mt-1">
          Agent rankings by composite score — updated every 30s
        </p>
      </div>

      {isLoading && (
        <div className="text-gray-400 text-sm">Loading agents...</div>
      )}

      {error && (
        <div className="text-red-400 text-sm">Failed to load leaderboard</div>
      )}

      {agents && agents.length === 0 && (
        <div className="text-gray-400 text-sm">
          No scored agents yet — windows are opening soon.
        </div>
      )}

      {agents && agents.length > 0 && (
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-gray-400 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">#</th>
                <th className="text-left px-4 py-3">Agent</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-right px-4 py-3">Score</th>
                <th className="text-right px-4 py-3">Windows</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent, i) => (
                <tr
                  key={agent.address}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/profile/${agent.address}`}
                      className="font-mono text-xs hover:text-blue-400 transition-colors"
                    >
                      {agent.address.slice(0, 6)}...{agent.address.slice(-4)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`font-medium ${TIER_COLORS[agent.tier]}`}>
                      {TIER_LABELS[agent.tier]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {(agent.compositeScore * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">
                    {agent.windowsCompleted}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}