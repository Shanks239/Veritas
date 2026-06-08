import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useSuiTransaction, PACKAGE_ID } from '../hooks/useSuiTransaction'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })

const label: React.CSSProperties = {
  fontSize: '0.6875rem',
  color: 'rgba(255,255,255,0.35)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: '8px',
}

interface AgentData {
  endpoint: string
  totalStakeSui: number
  delegators: { address: string; stake: number }[]
}

async function fetchMyAgentData(address: string): Promise<AgentData | null> {
  const [regEvents, delegEvents, undelegEvents] = await Promise.all([
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` }, limit: 50, order: 'descending' }),
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::registry::Delegated` }, limit: 100, order: 'descending' }),
    client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::registry::Undelegated` }, limit: 100, order: 'descending' }),
  ])

  const myReg = regEvents.data.find(e => (e.parsedJson as { agent: string }).agent === address)
  if (!myReg) return null
  const regField = myReg.parsedJson as { agent: string; endpoint: number[] }
  const endpoint = new TextDecoder().decode(new Uint8Array(regField.endpoint))

  // Aggregate delegations for this agent
  const stakes = new Map<string, number>()
  for (const e of delegEvents.data) {
    const f = e.parsedJson as { agent: string; delegator: string; stake_amount: string }
    if (f.agent !== address) continue
    stakes.set(f.delegator, (stakes.get(f.delegator) ?? 0) + Number(f.stake_amount))
  }
  for (const e of undelegEvents.data) {
    const f = e.parsedJson as { agent: string; delegator: string; returned: string }
    if (f.agent !== address) continue
    stakes.set(f.delegator, (stakes.get(f.delegator) ?? 0) - Number(f.returned))
  }

  const delegators = Array.from(stakes.entries())
    .filter(([, mist]) => mist > 0)
    .map(([addr, mist]) => ({ address: addr, stake: mist / 1e9 }))
    .sort((a, b) => b.stake - a.stake)

  const totalStakeSui = delegators.reduce((s, d) => s + d.stake, 0)

  return { endpoint, totalStakeSui, delegators }
}

export default function MyAgent() {
  const { primaryWallet } = useDynamicContext()
  const { updateEndpoint } = useSuiTransaction()
  const queryClient = useQueryClient()

  const walletAddress = primaryWallet ? (primaryWallet as unknown as { address: string }).address : null

  const { data: agent, isLoading } = useQuery({
    queryKey: ['my-agent', walletAddress],
    queryFn: () => fetchMyAgentData(walletAddress!),
    enabled: !!walletAddress,
    refetchOnMount: 'always',
  })

  const [editing, setEditing] = useState(false)
  const [newEndpoint, setNewEndpoint] = useState('')
  const [updateStatus, setUpdateStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [updating, setUpdating] = useState(false)

  function startEdit() {
    setNewEndpoint(agent?.endpoint ?? '')
    setEditing(true)
    setUpdateStatus(null)
  }

  async function handleUpdate() {
    if (!newEndpoint.trim()) return
    setUpdating(true)
    setUpdateStatus(null)
    try {
      const digest = await updateEndpoint(newEndpoint.trim())
      setUpdateStatus({ type: 'success', msg: `Endpoint updated · Tx: ${digest.slice(0, 16)}…` })
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['my-agent', walletAddress] })
    } catch (err) {
      setUpdateStatus({ type: 'error', msg: String(err) })
    } finally {
      setUpdating(false)
    }
  }

  if (!primaryWallet) {
    return (
      <div>
        <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 2rem', color: '#fff' }}>
          My Agent
        </h2>
        <div style={{
          padding: '14px 16px',
          border: '1px solid rgba(251,191,36,0.2)',
          borderRadius: '8px',
          background: 'rgba(251,191,36,0.05)',
          fontSize: '0.8125rem',
          color: 'rgba(251,191,36,0.8)',
        }}>
          Connect your wallet to manage your agent
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div>
        <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 2rem', color: '#fff' }}>
          My Agent
        </h2>
        <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.25)' }}>Loading…</div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div>
        <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 0.4rem', color: '#fff' }}>
          My Agent
        </h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: '0 0 2rem' }}>
          No agent registered for this wallet
        </p>
        <div style={{
          padding: '24px',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.02)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.5)' }}>
            Deploy your agent, then register its prediction endpoint to start competing in windows.
          </div>
          <Link to="/register" style={{
            display: 'inline-block',
            padding: '10px 20px',
            borderRadius: '8px',
            background: '#7c3aed',
            color: '#fff',
            fontSize: '0.875rem',
            fontWeight: 500,
            textDecoration: 'none',
            alignSelf: 'flex-start',
          }}>
            Register Agent
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontFamily: '"DM Serif Display", Georgia, serif', fontSize: '1.75rem', fontWeight: 400, margin: '0 0 0.4rem', color: '#fff' }}>
          My Agent
        </h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: 0 }}>
          Manage your registered prediction agent
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '2rem' }}>
        <div style={{ padding: '16px 20px', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Status</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34d399', display: 'inline-block' }} />
            <span style={{ fontSize: '1rem', color: '#34d399', fontWeight: 500 }}>Active</span>
          </div>
        </div>
        <div style={{ padding: '16px 20px', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '6px' }}>Total Staked</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 500, color: '#c084fc', fontFamily: '"DM Mono", monospace' }}>
            {agent.totalStakeSui.toFixed(4)} <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)' }}>SUI</span>
          </div>
        </div>
      </div>

      {/* Address */}
      <div style={{ marginBottom: '1.5rem' }}>
        <span style={label}>Agent Address</span>
        <div style={{
          padding: '10px 14px',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '8px',
          background: 'rgba(255,255,255,0.02)',
          fontFamily: '"DM Mono", monospace',
          fontSize: '0.8125rem',
          color: 'rgba(255,255,255,0.6)',
          wordBreak: 'break-all',
        }}>
          {walletAddress}
        </div>
      </div>

      {/* Endpoint */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ ...label, marginBottom: 0 }}>Prediction Endpoint</span>
          {!editing && (
            <button onClick={startEdit} style={{
              padding: '4px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: '0.6875rem',
              fontFamily: '"DM Mono", monospace',
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
              onMouseEnter={e => { (e.currentTarget.style.background = 'rgba(255,255,255,0.06)'); (e.currentTarget.style.color = '#fff') }}
              onMouseLeave={e => { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.color = 'rgba(255,255,255,0.5)') }}
            >
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="url"
              value={newEndpoint}
              onChange={e => setNewEndpoint(e.target.value)}
              placeholder="https://your-agent.example.com/predict"
              autoFocus
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleUpdate}
                disabled={!newEndpoint.trim() || updating}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: !newEndpoint.trim() || updating ? 'rgba(255,255,255,0.06)' : '#7c3aed',
                  color: !newEndpoint.trim() || updating ? 'rgba(255,255,255,0.2)' : '#fff',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  cursor: updating ? 'wait' : 'pointer',
                }}
              >
                {updating ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setEditing(false); setUpdateStatus(null) }} style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.4)',
                fontSize: '0.8125rem',
                cursor: 'pointer',
              }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{
            padding: '10px 14px',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: '8px',
            background: 'rgba(255,255,255,0.02)',
            fontFamily: '"DM Mono", monospace',
            fontSize: '0.8125rem',
            color: 'rgba(255,255,255,0.6)',
            wordBreak: 'break-all',
          }}>
            {agent.endpoint}
          </div>
        )}

        {updateStatus && (
          <div style={{
            marginTop: '8px',
            padding: '10px 14px',
            borderRadius: '8px',
            border: `1px solid ${updateStatus.type === 'success' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
            background: updateStatus.type === 'success' ? 'rgba(52,211,153,0.05)' : 'rgba(248,113,113,0.05)',
            fontSize: '0.8125rem',
            color: updateStatus.type === 'success' ? '#34d399' : '#f87171',
            fontFamily: '"DM Mono", monospace',
          }}>
            {updateStatus.msg}
          </div>
        )}
      </div>

      {/* Delegators */}
      <div>
        <span style={label}>Delegators ({agent.delegators.length})</span>
        {agent.delegators.length === 0 ? (
          <div style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.2)' }}>No delegators yet</div>
        ) : (
          <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: '10px', overflow: 'hidden' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr auto',
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
              fontSize: '0.6875rem', color: 'rgba(255,255,255,0.2)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
            }}>
              <div>Address</div><div>Staked</div>
            </div>
            {agent.delegators.map((d, i) => (
              <div key={d.address} style={{
                display: 'grid', gridTemplateColumns: '1fr auto',
                padding: '11px 16px',
                borderBottom: i < agent.delegators.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                alignItems: 'center',
              }}>
                <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.5)' }}>
                  {d.address.slice(0, 10)}…{d.address.slice(-6)}
                </div>
                <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: '#c084fc' }}>
                  {d.stake.toFixed(4)} SUI
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
