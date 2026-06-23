import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { fetchMyDelegations } from '../lib/delegations'
import { useSuiTransaction } from '../hooks/useSuiTransaction'

const card: React.CSSProperties = {
  padding: '16px 18px',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: '10px',
  background: 'rgba(255,255,255,0.02)',
}

function actionBtn(disabled: boolean, accent: string): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: '7px',
    border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : accent + '55'}`,
    background: disabled ? 'rgba(255,255,255,0.03)' : accent + '14',
    color: disabled ? 'rgba(255,255,255,0.25)' : accent,
    fontSize: '0.75rem',
    fontWeight: 500,
    fontFamily: '"DM Mono", monospace',
    letterSpacing: '0.03em',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 0.15s',
  }
}

export default function MyDelegations() {
  const { primaryWallet } = useDynamicContext()
  const { claimRewards, undelegateStake } = useSuiTransaction()
  const qc = useQueryClient()

  const walletAddress = primaryWallet ? (primaryWallet as unknown as { address: string }).address : null
  const [busy, setBusy] = useState<string | null>(null)   // `${agent}:${action}`
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const { data: delegations, isLoading } = useQuery({
    queryKey: ['my-delegations', walletAddress],
    queryFn: () => fetchMyDelegations(walletAddress!),
    enabled: !!walletAddress,
    refetchInterval: 30_000,
  })

  if (!walletAddress) return null
  if (!isLoading && (!delegations || delegations.length === 0)) return null

  async function run(agent: string, action: 'claim' | 'unstake') {
    setBusy(`${agent}:${action}`)
    setStatus(null)
    try {
      const digest = action === 'claim'
        ? await claimRewards(agent)
        : await undelegateStake(agent)
      setStatus({ type: 'success', msg: `${action === 'claim' ? 'Claimed rewards' : 'Unstaked'} · Tx: ${digest.slice(0, 16)}…` })
      // Give the fullnode a moment to index, then refresh balances + positions.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['my-delegations'] })
        qc.invalidateQueries({ queryKey: ['sui-balance'] })
      }, 1500)
    } catch (err) {
      setStatus({ type: 'error', msg: String(err).slice(0, 160) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: '2.5rem' }}>
      <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '12px' }}>
        Your Delegations
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {delegations?.map(d => {
          const claiming   = busy === `${d.agent}:claim`
          const unstaking  = busy === `${d.agent}:unstake`
          const anyBusy    = busy !== null
          const canClaim   = d.claimSui > 0 && !anyBusy
          const canUnstake = d.stakeSui > 0 && !anyBusy
          return (
            <div key={d.agent} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.75)', marginBottom: '8px' }}>
                    {d.agent.slice(0, 10)}…{d.agent.slice(-6)}
                  </div>
                  <div style={{ display: 'flex', gap: '20px' }}>
                    <div>
                      <div style={{ fontSize: '0.625rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '3px' }}>Staked</div>
                      <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.95rem', color: '#fff' }}>{d.stakeSui.toFixed(4)} <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>SUI</span></div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.625rem', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '3px' }}>Claimable</div>
                      <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.95rem', color: d.claimSui > 0 ? '#34d399' : 'rgba(255,255,255,0.4)' }}>{d.claimSui.toFixed(4)} <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>SUI</span></div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button style={actionBtn(!canClaim, '#34d399')} disabled={!canClaim} onClick={() => run(d.agent, 'claim')}>
                    {claiming ? 'Claiming…' : 'Claim'}
                  </button>
                  <button style={actionBtn(!canUnstake, '#f87171')} disabled={!canUnstake} onClick={() => run(d.agent, 'unstake')}>
                    {unstaking ? 'Unstaking…' : 'Unstake'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {status && (
        <div style={{
          marginTop: '12px',
          padding: '10px 14px',
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
  )
}
