import { useQuery } from '@tanstack/react-query'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { useEffect, useState } from 'react'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })
const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'

interface WindowData {
  id: string
  opensAt: number
  closesAt: number
  resolvesAt: number
  commitCount: number
  resolved: boolean
}

function Countdown({ target }: { target: number }) {
  const [remaining, setRemaining] = useState(target - Date.now())

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(target - Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [target])

  if (remaining <= 0) return <span className="text-gray-500">Elapsed</span>

  const secs  = Math.floor(remaining / 1000)
  const mins  = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)

  return (
    <span className="font-mono">
      {hours > 0 && `${hours}h `}
      {(mins % 60).toString().padStart(2, '0')}m{' '}
      {(secs % 60).toString().padStart(2, '0')}s
    </span>
  )
}

async function fetchWindows(): Promise<WindowData[]> {
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::window::WindowOpened` },
    limit: 20,
    order: 'descending',
  })

  return events.data.map(e => {
    const f = e.parsedJson as {
      window_id: string
      opens_at: string
      closes_at: string
      resolves_at: string
    }
    return {
      id:          f.window_id,
      opensAt:     Number(f.opens_at),
      closesAt:    Number(f.closes_at),
      resolvesAt:  Number(f.resolves_at),
      commitCount: 0,
      resolved:    false,
    }
  })
}

function phase(w: WindowData): { label: string; color: string } {
  const now = Date.now()
  if (now < w.closesAt)  return { label: 'Deliberating', color: 'text-blue-400' }
  if (now < w.resolvesAt) return { label: 'Awaiting horizon', color: 'text-yellow-400' }
  if (!w.resolved)        return { label: 'Resolvable', color: 'text-green-400' }
  return { label: 'Resolved', color: 'text-gray-500' }
}

export default function Windows() {
  const { data: windows, isLoading } = useQuery({
    queryKey: ['windows'],
    queryFn:  fetchWindows,
    refetchInterval: 10_000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Prediction Windows</h1>
        <p className="text-gray-400 text-sm mt-1">
          Active and recent windows — new window opens every 60s
        </p>
      </div>

      {isLoading && <div className="text-gray-400 text-sm">Loading windows...</div>}

      {windows && windows.length === 0 && (
        <div className="text-gray-400 text-sm">No windows opened yet.</div>
      )}

      {windows && windows.length > 0 && (
        <div className="space-y-3">
          {windows.map(w => {
            const p = phase(w)
            return (
              <div key={w.id} className="rounded-xl border border-white/10 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-gray-400">
                    {w.id.slice(0, 10)}...
                  </span>
                  <span className={`text-xs font-medium ${p.color}`}>
                    {p.label}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-gray-500 text-xs mb-1">Closes in</div>
                    <Countdown target={w.closesAt} />
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs mb-1">Resolves in</div>
                    <Countdown target={w.resolvesAt} />
                  </div>
                  <div>
                    <div className="text-gray-500 text-xs mb-1">Commits</div>
                    <span className="font-mono">{w.commitCount}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}