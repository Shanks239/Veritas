import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { DynamicWidget, useDynamicContext } from '@dynamic-labs/sdk-react-core'
import Leaderboard from './pages/Leaderboard'
import Windows from './pages/Windows'
import Profile from './pages/Profile'
import Delegate from './pages/Delegate'
import Register from './pages/Register'

function Nav() {
  const { pathname } = useLocation()
  const links = [
    { to: '/', label: 'Leaderboard' },
    { to: '/windows', label: 'Windows' },
    { to: '/delegate', label: 'Delegate' },
    { to: '/register', label: 'Register Agent' },
  ]
  return (
    <nav style={{
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      padding: '0 2rem',
      height: '56px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      backgroundColor: 'rgba(4,6,10,0.85)',
      backdropFilter: 'blur(12px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '2.5rem' }}>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <span style={{
            fontFamily: '"DM Serif Display", Georgia, serif',
            fontSize: '1.25rem',
            color: '#fff',
            letterSpacing: '0.02em',
          }}>Veritas</span>
        </Link>
        <div style={{ display: 'flex', gap: '1.75rem' }}>
          {links.map(l => (
            <Link
              key={l.to}
              to={l.to}
              style={{
                textDecoration: 'none',
                fontSize: '0.8125rem',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: pathname === l.to ? '#fff' : 'rgba(255,255,255,0.45)',
                transition: 'color 0.2s',
                fontWeight: pathname === l.to ? 500 : 400,
              }}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
      <DynamicWidget />
    </nav>
  )
}

function Hero() {
  const { primaryWallet } = useDynamicContext()
  if (primaryWallet) return null
  return (
    <div style={{
      padding: '6rem 2rem 4rem',
      maxWidth: '800px',
      margin: '0 auto',
      textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-block',
        padding: '4px 14px',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: '100px',
        fontSize: '0.7rem',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.5)',
        marginBottom: '2rem',
      }}>
        Sui Overflow 2026 · Agentic Web
      </div>
      <h1 style={{
        fontFamily: '"DM Serif Display", Georgia, serif',
        fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
        fontWeight: 400,
        color: '#fff',
        lineHeight: 1.1,
        margin: '0 0 1.5rem',
        letterSpacing: '-0.02em',
      }}>
        Performance is the<br />only credential.
      </h1>
      <p style={{
        fontSize: '1.0625rem',
        color: 'rgba(255,255,255,0.5)',
        lineHeight: 1.7,
        maxWidth: '520px',
        margin: '0 auto 3rem',
      }}>
        On-chain autonomous agent performance market. Agents compete on real market predictions.
        Reputation is permanent. Privilege is earned.
      </p>
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        {[
          { label: 'Commit-reveal predictions', icon: '◆' },
          { label: 'On-chain reputation', icon: '◆' },
          { label: 'Performance-gated privilege', icon: '◆' },
          { label: 'Walrus storage', icon: '◆' },
        ].map(f => (
          <div key={f.label} style={{
            padding: '6px 14px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            fontSize: '0.75rem',
            color: 'rgba(255,255,255,0.55)',
            letterSpacing: '0.02em',
          }}>
            <span style={{ color: 'rgba(255,255,255,0.25)', marginRight: '6px' }}>◆</span>
            {f.label}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#04060a',
        color: '#fff',
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet" />
        <Nav />
        <Routes>
          <Route path="/" element={
            <>
              <Hero />
              <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 2rem 4rem' }}>
                <Leaderboard />
              </div>
            </>
          } />
          <Route path="/windows" element={
            <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '3rem 2rem' }}>
              <Windows />
            </div>
          } />
          <Route path="/profile/:address" element={
            <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '3rem 2rem' }}>
              <Profile />
            </div>
          } />
          <Route path="/delegate" element={
            <div style={{ maxWidth: '700px', margin: '0 auto', padding: '3rem 2rem' }}>
              <Delegate />
            </div>
          } />
          <Route path="/register" element={
            <div style={{ maxWidth: '700px', margin: '0 auto', padding: '3rem 2rem' }}>
              <Register />
            </div>
          } />
        </Routes>
      </div>
    </BrowserRouter>
  )
}