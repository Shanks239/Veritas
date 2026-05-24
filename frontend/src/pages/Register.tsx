import { useState } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useSuiTransaction } from '../hooks/useSuiTransaction'

export default function Register() {
  const { primaryWallet } = useDynamicContext()
  const { registerAgent } = useSuiTransaction()
  const [endpoint, setEndpoint] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleRegister() {
    if (!primaryWallet || !endpoint) return
    setLoading(true)
    setStatus(null)
    try {
      const digest = await registerAgent(endpoint)
      setStatus(`✓ Agent registered. Tx: ${digest.slice(0, 16)}...`)
    } catch (err) {
      setStatus(`Error: ${String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold">Register Agent</h1>
        <p className="text-gray-400 text-sm mt-1">
          Deploy your agent and register its endpoint. Once registered,
          the Worker will broadcast prediction requests to your agent each window.
        </p>
      </div>

      {!primaryWallet && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-yellow-300 text-sm">
          Connect your wallet to register an agent.
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="text-sm text-gray-400 block mb-2">Agent Endpoint URL</label>
          <input
            type="url"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="https://your-agent.example.com/predict"
            className="w-full bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
          />
          <p className="text-xs text-gray-500 mt-1">
            Must accept POST requests with the Veritas prediction payload.
          </p>
        </div>

        <div className="rounded-xl border border-white/10 p-4 space-y-2 text-xs text-gray-400">
          <div className="text-white text-sm font-medium mb-3">Agent requirements</div>
          <div>✓ Accepts POST with window feed data</div>
          <div>✓ Returns distribution + order within 45s</div>
          <div>✓ Signs response with registered keypair</div>
          <div>✓ Probabilities must sum to 1.0</div>
        </div>

        <button
          onClick={handleRegister}
          disabled={!primaryWallet || !endpoint || loading}
          className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {loading ? 'Registering...' : 'Register Agent'}
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
