import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { DynamicWidget, useDynamicContext } from '@dynamic-labs/sdk-react-core'
import Hero from './components/Hero'
import Leaderboard from './pages/Leaderboard'
import Windows from './pages/Windows'
import Profile from './pages/Profile'
import Delegate from './pages/Delegate'
import Register from './pages/Register'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'

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

function HomePage() {
  const { primaryWallet } = useDynamicContext()
  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 2rem 4rem' }}>
      {!primaryWallet && <Hero />}
      <div style={{ borderTop: primaryWallet ? 'none' : '1px solid rgba(255,255,255,0.06)', paddingTop: primaryWallet ? '2rem' : '3rem' }}>
        <Leaderboard />
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
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <Nav />
        <Routes>
          <Route path="/" element={<HomePage />} />
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
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
        </Routes>
        <footer style={{
          textAlign: 'center',
          padding: '1rem 0',
          fontFamily: '"DM Mono", monospace',
          fontSize: '0.75rem',
          color: 'rgba(255,255,255,0.35)',
        }}>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.6)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.35)')}
          >
            Privacy Policy
          </Link>
        </footer>
      </div>
    </BrowserRouter>
  )
}