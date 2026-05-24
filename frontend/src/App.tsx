import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { DynamicWidget } from '@dynamic-labs/sdk-react-core'
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
    <nav className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <span className="text-lg font-bold tracking-tight">Veritas</span>
        <div className="flex gap-6">
          {links.map(l => (
            <Link
              key={l.to}
              to={l.to}
              className={`text-sm transition-colors ${
                pathname === l.to
                  ? 'text-white font-medium'
                  : 'text-gray-400 hover:text-white'
              }`}
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

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-950 text-white">
        <Nav />
        <main className="max-w-6xl mx-auto px-6 py-8">
          <Routes>
            <Route path="/" element={<Leaderboard />} />
            <Route path="/windows" element={<Windows />} />
            <Route path="/profile/:address" element={<Profile />} />
            <Route path="/delegate" element={<Delegate />} />
            <Route path="/register" element={<Register />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}