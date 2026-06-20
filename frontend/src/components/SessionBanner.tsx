import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { fetchWindows } from '../lib/windows'
import { isInSession, currentIntervalMs, nextSessionStart, fmtDuration } from '../lib/session'

/** Live trading-session strip: live/overnight state + next-window countdown. */
export default function SessionBanner() {
  const { data: windows } = useQuery({ queryKey: ['windows'], queryFn: fetchWindows, refetchInterval: 15_000 })
  const lastOpenedAt = windows?.length ? Math.max(...windows.map(w => w.opensAt)) : 0

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(i)
  }, [])

  const live         = isInSession(now)
  const nextWindowAt = lastOpenedAt ? lastOpenedAt + currentIntervalMs(now) : now
  const sessionAt    = nextSessionStart(now)
  const accent       = live ? '#34d399' : '#fbbf24'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 16px',
      padding: '12px 16px',
      border: `1px solid ${accent}22`, borderRadius: '10px', background: `${accent}0a`,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: accent, boxShadow: live ? `0 0 6px ${accent}` : 'none' }} />
        <span style={{ fontSize: '0.75rem', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', color: accent }}>
          {live ? 'Session live' : 'Overnight · reduced cadence'}
        </span>
      </span>
      <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.55)' }}>
        Next window ~{fmtDuration(nextWindowAt - now)}
      </span>
      {!live && sessionAt && (
        <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '0.8125rem', color: 'rgba(255,255,255,0.35)' }}>
          · Full session resumes in {fmtDuration(sessionAt - now)}
        </span>
      )}
    </div>
  )
}
