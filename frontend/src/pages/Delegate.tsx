import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useSuiTransaction } from '../hooks/useSuiTransaction'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

interface RegisteredAgent {
  agent: string
  endpoint: string
}

async function fetchRegisteredAgents(): Promise<RegisteredAgent[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` },
    limit: 50,
    order: 'descending',
  })
  return events.data.map(e => {
    const f = e.parsedJson as { agent: string; endpoint: string }
    return { agent: f.agent, endpoint: f.endpoint }
  })
}

export default function Delegate() {
  const { primaryWallet } = useDynamicContext()
  const { delegateStake } = useSuiTransaction()
  const [selectedAgent, setSelectedAgent] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const { data: agents, isLoading } = useQuery({
    queryKey: ['registered-agents'],
    queryFn:  fetchRegisteredAgents,
    refetchInterval: 30_000,
  })

  async function handleDelegate() {
    if (!primaryWallet || !selectedAgent || !amount) return
    setLoading(true)
    setStatus(null)
    try {
      const amountMist = BigInt(Math.round(parseFloat(amount) * 1_000_000_000))
      const digest = await delegateStake(selectedAgent, amountMist)
      setStatus(`✓ Delegated ${amount} SUI. Tx: ${digest.slice(0, 16)}...`)
    } catch (err) {
      setStatus(`Error: ${String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold">Delegate Stake</h1>
        <p className="text-gray-400 text-sm mt-1">
          Stake SUI behind an agent and earn 20% of their performance revenue.
        </p>
      </div>

      {!primaryWallet && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-yellow-300 text-sm">
          Connect your wallet to delegate.
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="text-sm text-gray-400 block mb-2">Select Agent</label>
          {isLoading && <div className="text-gray-500 text-sm">Loading agents...</div>}
          {agents && agents.length === 0 && (
            <div className="text-gray-500 text-sm">No registered agents yet.</div>
          )}
          {agents && agents.length > 0 && (
            <select
              value={selectedAgent}
              onChange={e => setSelectedAgent(e.target.value)}
              className="w-full bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">Choose an agent...</option>
              {agents.map(a => (
                <option key={a.agent} value={a.agent}>
                  {a.agent.slice(0, 10)}... — {a.endpoint.slice(0, 30)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="text-sm text-gray-400 block mb-2">Amount (SUI)</label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.0"
            className="w-full bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>

        <button
          onClick={handleDelegate}
          disabled={!primaryWallet || !selectedAgent || !amount || loading}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {loading ? 'Delegating...' : 'Delegate'}
        </button>

        {status && (
          <div className={`text-sm mt-2 ${status.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  )
}
