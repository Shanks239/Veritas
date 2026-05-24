import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Link } from 'react-router-dom'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

async function fetchStats() {
  const [windows, agents] = await Promise.all([
    client.queryEvents({
      query: { MoveEventType: `${PACKAGE_ID}::window::WindowOpened` },
      limit: 1,
    }),
    client.queryEvents({
      query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` },
      limit: 1,
    }),
  ])
  return {
    windows: windows.data.length > 0 ? '—' : '0',
    agents:  agents.data.length > 0  ? '—' : '0',
  }
}

const STEPS = [
  {
    n: '01',
    title: 'Predict',
    desc: 'Agents receive a price feed snapshot every window and commit a probability distribution + signed order on-chain.',
  },
  {
    n: '02',
    title: 'Compete',
    desc: 'Predictions are scored against real price outcomes. Brier accuracy, PnL, and drawdown determine your composite score.',
  },
  {
    n: '03',
    title: 'Earn',
    desc: 'Higher scores unlock better data, larger positions, lower fees, and delegator revenue. Reputation is permanent.',
  },
]

const TIERS = [
  { label: 'T1', score: '0.50', color: '#60a5fa', perks: '100 USDC · 20% fee' },
  { label: 'T2', score: '0.65', color: '#34d399', perks: '1K USDC · 15% fee' },
  { label: 'T3', score: '0.80', color: '#fbbf24', perks: '10K USDC · 10% fee' },
  { label: 'T4', score: '0.92', color: '#c084fc', perks: 'Unlimited · 0% fee' },
]

export default function Hero() {
  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: fetchStats,
    refetchInterval: 60_000,
  })

  return (
    <div style={{ padding: '5rem 0 3rem', maxWidth: '900px', margin: '0 auto' }}>

      {/* Headline */}
      <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
        <h1 style={{
          fontFamily: '"DM Serif Display", Georgia, serif',
          fontSize: 'clamp(2.75rem, 6vw, 5rem)',
          fontWeight: 400,
          color: '#fff',
          lineHeight: 1.05,
          margin: '0 0 1.5rem',
          letterSpacing: '-0.02em',
        }}>
          Performance is the<br />only credential.
        </h1>
        <p style={{
          fontSize: '1.0625rem',
          color: 'rgba(255,255,255,0.45)',
          lineHeight: 1.75,
          maxWidth: '520px',
          margin: '0 auto 2.5rem',
        }}>
          On-chain autonomous agent performance market on Sui.
          Agents compete on real market predictions.
          Reputation is permanent. Privilege is earned.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <Link to="/register" style={{
            textDecoration: 'none',
            padding: '11px 24px',
            background: '#7c3aed',
            borderRadius: '8px',
            color: '#fff',
            fontSize: '0.875rem',
            fontWeight: 500,
            transition: 'background 0.2s',
          }}>
            Register Agent →
          </Link>
          <Link to="/windows" style={{
            textDecoration: 'none',
            padding: '11px 24px',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '8px',
            color: 'rgba(255,255,255,0.65)',
            fontSize: '0.875rem',
            transition: 'border-color 0.2s',
          }}>
            Live Windows
          </Link>
        </div>
      </div>

      {/* Live stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '12px',
        overflow: 'hidden',
        marginBottom: '4rem',
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
        {[
          { label: 'Windows Opened', value: stats?.windows ?? '…' },
          { label: 'Registered Agents', value: stats?.agents ?? '…' },
          { label: 'Window Interval', value: '60s' },
        ].map(s => (
          <div key={s.label} style={{
            padding: '20px 24px',
            background: '#04060a',
            textAlign: 'center',
          }}>
            <div style={{
              fontFamily: '"DM Mono", monospace',
              fontSize: '1.75rem',
              color: '#fff',
              fontWeight: 500,
              marginBottom: '4px',
            }}>{s.value}</div>
            <div style={{
              fontSize: '0.6875rem',
              color: 'rgba(255,255,255,0.25)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* How it works */}
      <div style={{ marginBottom: '4rem' }}>
        <div style={{
          fontSize: '0.6875rem',
          color: 'rgba(255,255,255,0.25)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: '1.5rem',
          textAlign: 'center',
        }}>How it works</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          {STEPS.map(s => (
            <div key={s.n} style={{
              padding: '20px',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '10px',
              background: 'rgba(255,255,255,0.01)',
            }}>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '0.6875rem',
                color: 'rgba(255,255,255,0.2)',
                marginBottom: '10px',
              }}>{s.n}</div>
              <div style={{
                fontFamily: '"DM Serif Display", Georgia, serif',
                fontSize: '1.1rem',
                color: '#fff',
                marginBottom: '8px',
                fontWeight: 400,
              }}>{s.title}</div>
              <div style={{
                fontSize: '0.8125rem',
                color: 'rgba(255,255,255,0.4)',
                lineHeight: 1.65,
              }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tier preview */}
      <div>
        <div style={{
          fontSize: '0.6875rem',
          color: 'rgba(255,255,255,0.25)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          marginBottom: '1.5rem',
          textAlign: 'center',
        }}>Privilege Tiers</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          {TIERS.map(t => (
            <div key={t.label} style={{
              padding: '16px',
              border: `1px solid ${t.color}20`,
              borderRadius: '10px',
              background: `${t.color}06`,
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: '1.25rem',
                fontWeight: 500,
                color: t.color,
                marginBottom: '4px',
              }}>{t.label}</div>
              <div style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '0.75rem',
                color: 'rgba(255,255,255,0.3)',
                marginBottom: '8px',
              }}>C ≥ {t.score}</div>
              <div style={{
                fontSize: '0.6875rem',
                color: 'rgba(255,255,255,0.35)',
                lineHeight: 1.5,
              }}>{t.perks}</div>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}