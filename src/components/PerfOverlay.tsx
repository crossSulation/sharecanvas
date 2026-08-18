import { useEffect, useState } from 'react'
import { getPerfStats } from '../lib/perf'

interface RendererDiag {
  workerOk: boolean
  workerCount: number
  offscreenCanvas: boolean
  dpr: number
  hardwareConcurrency: number
  userAgent: string
}

function getDiag(): RendererDiag | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (window as any).__sharecanvasDiag
  return d ?? null
}

export default function PerfOverlay() {
  const [stats, setStats] = useState(getPerfStats())

  useEffect(() => {
    let raf = 0
    const tick = () => {
      setStats(getPerfStats())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const diag = getDiag()
  const fpsColor =
    stats.fps >= 55 ? 'text-emerald-500' : stats.fps >= 30 ? 'text-amber-500' : 'text-red-500'
  const drawColor = stats.drawAvg < 8 ? 'text-emerald-500' : stats.drawAvg < 16 ? 'text-amber-500' : 'text-red-500'

  return (
    <div className="pointer-events-none absolute right-3 top-12 z-50 rounded-lg bg-black/60 px-2.5 py-1.5 text-[10px] leading-relaxed text-white backdrop-blur sm:right-3">
      <span className={fpsColor}>{stats.fps}</span>
      <span className="text-white/50"> fps</span>
      <span className="mx-1.5 text-white/25">|</span>
      <span className={drawColor}>{stats.drawAvg}ms</span>
      <span className="text-white/50"> draw</span>
      {diag && (
        <div className="mt-0.5 border-t border-white/15 pt-0.5">
          <span className={diag.workerOk ? 'text-emerald-400' : 'text-red-400'}>
            {diag.workerOk ? `worker×${diag.workerCount}` : 'SYNC-FALLBACK'}
          </span>
          <span className="text-white/40"> oc={diag.offscreenCanvas ? 'y' : 'n'}</span>
          <span className="text-white/40"> dpr={diag.dpr}</span>
          <span className="text-white/40"> cpu={diag.hardwareConcurrency}</span>
        </div>
      )}
    </div>
  )
}
