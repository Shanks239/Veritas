import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useSuiTransaction } from '../hooks/useSuiTransaction'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

interface RegisteredAgent { agent: string; endpoint: string }

async function fetchRegisteredAgents(): Promise<RegisteredAgent[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` },
    limit: 50, order: 'descending',
  })
  return events.data.map(e => {
    const f = e.parsedJson as { agent: string; endpoint: string }
    // Sui serializes vector<u8> as base64 in event parsedJson — decode to URL string
    return { agent: f.agent, endpoint: atob(f.endpoint) }
  })
}

const label: React.CSSProperties = {
  fontSize: '0.6875rem',
  color: 'rgba(255,255,255,0.35)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: '8px',
}

export default function Delegate() {
  const { primaryWallet } = useDynamicContext()
  const { delegateStake } = useSuiTransaction()
  const [selectedAgent, setSelectedAgent] = useState('')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const { data: agents, isLoading } = useQuery({
    queryKey: ['registered-agents'],
    queryFn: fetchRegisteredAgents,
    refetchInterval: 30_000,
  })

  async function handleDelegate() {
    if (!primaryWallet || !selectedAgent || !amount) return
    setLoading(true)
    setStatus(null)
    try {
      const amountMist = BigInt(Math.round(parseFloat(amount) * 1_000_000_000))
      const digest = await delegateStake(selectedAgent, amountMist)
      setStatus({ type: 'success', msg: `Delegated ${amount} SUI · Tx: ${digest.slice(0, 16)}…` })
    } catch (err) {
      setStatus({ type: 'error', msg: String(err) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 0.4rem', color: '#fff' }}>
          Delegate Stake
        </h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: 0 }}>
          Stake SUI behind an agent and earn 20% of their performance revenue
        </p>
      </div>

      {/* Revenue split info */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '2rem',
      }}>
        {[
          { label: 'Agent share', value: '80%', color: '#c084fc' },
          { label: 'Delegator share', value: '20%', color: '#34d399' },
        ].map(s => (
          <div key={s.label} style={{
            padding: '16px 20px',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '10px',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>{s.label}</div>
            <div style={{ fontSize: '1.75rem', fontWeight: 500, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {!primaryWallet && (
        <div style={{
          padding: '14px 16px',
          border: '1px solid rgba(251,191,36,0.2)',
          borderRadius: '8px',
          background: 'rgba(251,191,36,0.05)',
          fontSize: '0.8125rem',
          color: 'rgba(251,191,36,0.8)',
          marginBottom: '1.5rem',
        }}>
          Connect your wallet to delegate stake
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <span style={label}>Select Agent</span>
          {isLoading && <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.25)' }}>Loading agents...</div>}
          {agents && agents.length === 0 && (
            <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.25)' }}>No registered agents yet</div>
          )}
          {agents && agents.length > 0 && (
            <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}>
              <option value="">Choose an agent…</option>
              {agents.map(a => (
                <option key={a.agent} value={a.agent}>
                  {a.agent.slice(0, 10)}… · {a.endpoint.slice(0, 35)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <span style={label}>Amount (SUI)</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.0"
          />
        </div>

        <button
          onClick={handleDelegate}
          disabled={!primaryWallet || !selectedAgent || !amount || loading}
          style={{
            padding: '12px',
            borderRadius: '8px',
            border: 'none',
            background: !primaryWallet || !selectedAgent || !amount || loading
              ? 'rgba(255,255,255,0.06)' : '#7c3aed',
            color: !primaryWallet || !selectedAgent || !amount || loading
              ? 'rgba(255,255,255,0.2)' : '#fff',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: loading ? 'wait' : 'pointer',
            transition: 'background 0.2s',
          }}
        >
          {loading ? 'Delegating…' : 'Delegate Stake'}
        </button>

        {status && (
          <div style={{
            padding: '12px 16px',
            borderRadius: '8px',
            border: `1px solid ${status.type === 'success' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
            background: status.type === 'success' ? 'rgba(52,211,153,0.05)' : 'rgba(248,113,113,0.05)',
            fontSize: '0.8125rem',
            color: status.type === 'success' ? '#34d399' : '#f87171',
            fontFamily: '"DM Mono", monospace',
          }}>
            {status.msg}
          </div>
        )}
      </div>
    </div>
  )
}