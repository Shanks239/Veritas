import { useState } from 'react'
import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { useSuiTransaction } from '../hooks/useSuiTransaction'

const label: React.CSSProperties = {
  fontSize: '0.6875rem',
  color: 'rgba(255,255,255,0.35)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  display: 'block',
  marginBottom: '8px',
}

const REQUIREMENTS = [
  { icon: '→', text: 'Accept POST requests with the Veritas prediction payload' },
  { icon: '→', text: 'Respond with distribution + signed order within 45 seconds' },
  { icon: '→', text: 'Probabilities across all buckets must sum to 1.0' },
  { icon: '→', text: 'Sign your response with your registered keypair' },
]

const TIERS = [
  { tier: 'T1', score: '≥ 0.50', limit: '100 USDC', fee: '20%', markets: 'SUI/USDC' },
  { tier: 'T2', score: '≥ 0.65', limit: '1,000 USDC', fee: '15%', markets: 'Top 5' },
  { tier: 'T3', score: '≥ 0.80', limit: '10,000 USDC', fee: '10%', markets: 'All' },
  { tier: 'T4', score: '≥ 0.92', limit: 'Unlimited', fee: '0%', markets: 'All + propose' },
]

const TIER_COLORS: Record<string, string> = {
  T1: '#60a5fa', T2: '#34d399', T3: '#fbbf24', T4: '#c084fc',
}

export default function Register() {
  const { primaryWallet } = useDynamicContext()
  const { registerAgent, createProfile } = useSuiTransaction()
  const [endpoint, setEndpoint] = useState('')
  const [status, setStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleRegister() {
    if (!primaryWallet || !endpoint) return
    setLoading(true)
    setStatus(null)
    try {
      const digest = await registerAgent(endpoint)

      // Create on-chain scoring profile (idempotent — ignore if already exists)
      try {
        await createProfile()
      } catch {
        // Profile likely already exists; non-fatal
      }

      // Refresh worker's agent registry cache so the cron picks up the new endpoint
      const workerUrl = import.meta.env.VITE_WORKER_URL
      if (workerUrl) fetch(`${workerUrl}/admin/sync-agents`, { method: 'POST' }).catch(() => {})

      setStatus({ type: 'success', msg: `Agent registered · Tx: ${digest.slice(0, 16)}…` })
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
          Register Agent
        </h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)', margin: 0 }}>
          Deploy your agent, register its endpoint, and start competing in prediction windows
        </p>
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
          Connect your wallet to register an agent
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '2.5rem' }}>
        <div>
          <span style={label}>Agent Endpoint URL</span>
          <input
            type="url"
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="https://your-agent.example.com/predict"
          />
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)', marginTop: '6px' }}>
            The Worker broadcasts prediction requests to this URL every window
          </div>
        </div>

        <button
          onClick={handleRegister}
          disabled={!primaryWallet || !endpoint || loading}
          style={{
            padding: '12px',
            borderRadius: '8px',
            border: 'none',
            background: !primaryWallet || !endpoint || loading ? 'rgba(255,255,255,0.06)' : '#7c3aed',
            color: !primaryWallet || !endpoint || loading ? 'rgba(255,255,255,0.2)' : '#fff',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: loading ? 'wait' : 'pointer',
            transition: 'background 0.2s',
          }}
        >
          {loading ? 'Registering…' : 'Register Agent'}
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

      {/* Requirements */}
      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ ...label, marginBottom: '12px' }}>Agent Requirements</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {REQUIREMENTS.map(r => (
            <div key={r.text} style={{ display: 'flex', gap: '12px', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ color: 'rgba(255,255,255,0.2)', flexShrink: 0 }}>{r.icon}</span>
              {r.text}
            </div>
          ))}
        </div>
      </div>

      {/* Tier table */}
      <div>
        <div style={{ ...label, marginBottom: '12px' }}>Privilege Tiers</div>
        <div style={{
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '60px 1fr 1fr 60px 1fr',
            padding: '10px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            fontSize: '0.6875rem',
            color: 'rgba(255,255,255,0.2)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>
            {['Tier', 'Score', 'Position', 'Fee', 'Markets'].map(h => <div key={h}>{h}</div>)}
          </div>
          {TIERS.map((t, i) => (
            <div key={t.tier} style={{
              display: 'grid',
              gridTemplateColumns: '60px 1fr 1fr 60px 1fr',
              padding: '12px 16px',
              borderBottom: i < TIERS.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              fontSize: '0.8125rem',
              alignItems: 'center',
            }}>
              <div style={{ fontWeight: 500, color: TIER_COLORS[t.tier] }}>{t.tier}</div>
              <div style={{ fontFamily: '"DM Mono", monospace', color: 'rgba(255,255,255,0.6)' }}>{t.score}</div>
              <div style={{ color: 'rgba(255,255,255,0.6)' }}>{t.limit}</div>
              <div style={{ fontFamily: '"DM Mono", monospace', color: 'rgba(255,255,255,0.6)' }}>{t.fee}</div>
              <div style={{ color: 'rgba(255,255,255,0.6)' }}>{t.markets}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}