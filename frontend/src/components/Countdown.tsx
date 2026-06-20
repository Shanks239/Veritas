import { useEffect, useState } from 'react'

export default function Countdown({ target, dim }: { target: number; dim?: boolean }) {
  const [remaining, setRemaining] = useState(target - Date.now())
  useEffect(() => {
    const interval = setInterval(() => setRemaining(target - Date.now()), 1000)
    return () => clearInterval(interval)
  }, [target])

  if (remaining <= 0) return (
    <span style={{ color: 'rgba(255,255,255,0.2)', fontFamily: '"DM Mono", monospace', fontSize: '0.875rem' }}>
      Elapsed
    </span>
  )

  const secs  = Math.floor(remaining / 1000)
  const mins  = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)

  return (
    <span style={{
      fontFamily: '"DM Mono", monospace',
      fontSize: '0.875rem',
      color: dim ? 'rgba(255,255,255,0.4)' : '#fff',
    }}>
      {hours > 0 && `${hours}h `}
      {String(mins % 60).padStart(2, '0')}m{' '}
      {String(secs % 60).padStart(2, '0')}s
    </span>
  )
}
