import { smoothPoints, detectShape } from './aiDraw'
import { useStore } from '../store'
import { yDeleteItems, yPush, yUpdateStrokePoints } from './yroom'
import { createId } from './id'
import { nextSeq } from './seq'
import type { Pt } from '../types'

interface BackendAI {
  beautify_stroke(args: { points: { x: number; y: number }[] }): Promise<{
    points: { x: number; y: number }[]
    detectedShape: { kind: string; x0: number; y0: number; x1: number; y1: number; confidence: number } | null
  }>
}

type BackendName = 'tauri' | 'native-server' | 'js-fallback'

export async function showLogPath() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(window as any).__TAURI_INTERNALS__) {
    console.log('%c[AI] log: %crunning in browser, no file log', 'color:#a1a1aa', 'color:#a1a1aa')
    return
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const path = await invoke<string>('log_file_path')
    console.log('%c[AI] log file: %c%s', 'color:#a1a1aa', 'color:#3b82f6', path || '(empty — path not set)')
  } catch (e) {
    console.log('%c[AI] log file error: %c%s', 'color:#a1a1aa', 'color:#f87171', String(e))
  }
}

async function getBackend(): Promise<{ backend: BackendAI; name: BackendName } | null> {
  // 仅 Tauri 环境才尝试加载 @tauri-apps/api
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend: BackendAI = { beautify_stroke: (args: any) => invoke('beautify_stroke', args) }
      return { backend, name: 'tauri' }
    } catch {
      /* Tauri API not available */
    }
  }

  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('/api/ai/beautify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: [] }),
      })
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        return {
          name: 'native-server',
          backend: {
            beautify_stroke: async (args) => {
              const r = await fetch('/api/ai/beautify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
              })
              return r.json()
            },
          },
        }
      }
    } catch {
      /* server AI not reachable */
    }
  }

  return null
}

function extractPoints(points: unknown[]): Pt[] {
  return points.map((p) => {
    if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
      return { x: Number((p as { x: number }).x), y: Number((p as { y: number }).y) }
    }
    return { x: 0, y: 0 }
  }).filter((p) => isFinite(p.x) && isFinite(p.y))
}

function regeneratePoints(shape: { kind: string; x0: number; x1: number; funcParams?: number[] }): Pt[] {
  const params = shape.funcParams
  if (!params) return []
  const n = 100
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = shape.x0 + t * (shape.x1 - shape.x0)
    let y: number
    if (shape.kind === 'linear' && params.length >= 2) {
      y = params[0]! * x + params[1]!
    } else if (shape.kind === 'quadratic' && params.length >= 3) {
      y = params[0]! * x * x + params[1]! * x + params[2]!
    } else {
      return []
    }
    pts.push({ x, y })
  }
  return pts
}

function handleDetected(id: string, detected: { kind: string; x0: number; y0: number; x1: number; y1: number; funcParams?: number[] }, strokeColor: string, strokeSize: number, strokeLayer?: string) {
  const isFunc = (detected.kind === 'linear' || detected.kind === 'quadratic') && detected.funcParams
  if (isFunc) {
    const newPts = regeneratePoints(detected)
    if (newPts.length > 0) {
      yUpdateStrokePoints(id, newPts)
      return 'func'
    }
  }
  yDeleteItems('strokes', [id])
  yPush('shapes', [{
    id: createId('sh'),
    kind: detected.kind,
    x0: detected.x0, y0: detected.y0,
    x1: detected.x1, y1: detected.y1,
    color: strokeColor,
    size: strokeSize,
    seq: nextSeq(),
    layer: strokeLayer,
  }])
  return 'shape'
}

export async function beautifySelected(): Promise<number> {
  const t0 = performance.now()
  const s = useStore.getState()
  const strokeIds = s.selected.filter((id) => s.doc.strokes.some((st) => st.id === id))
  if (!strokeIds.length) return 0

  const resolved = await getBackend()
  const backend = resolved?.backend ?? null
  const pathLabel = resolved?.name ?? 'js-fallback'

  console.log(
    `%c[beautify] %cpath=%c${pathLabel} %cstrokes=%c${strokeIds.length}`,
    'color:#8b5cf6;font-weight:bold', '', 'color:#3b82f6', '', 'color:#18181b;font-weight:bold',
  )

  let smoothedCount = 0
  let shapeCount = 0

  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 3) continue

    const pts = extractPoints(st.points)
    if (pts.length < 3) continue

    const t1 = performance.now()

    if (backend) {
      const result = await backend.beautify_stroke({ points: pts })
      const smoothed = result.points as Pt[]
      const detected = result.detectedShape

      if (detected && detected.confidence > 0.85 && pts.length > 10) {
        const result = handleDetected(id, detected, st.color, st.size, st.layer)
        console.log(
          `  %c→ ${result} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
          result === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
        )
        if (result === 'func') smoothedCount++
        else shapeCount++
      } else {
        yUpdateStrokePoints(id, smoothed)
        smoothedCount++
      }
    } else {
      const smoothed = smoothPoints(pts, 2)
      const detected = detectShape(smoothed)

      if (detected && detected.confidence > 0.85 && pts.length > 10) {
        const result = handleDetected(id, detected, st.color, st.size, st.layer)
        console.log(
          `  %c→ ${result} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
          result === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
        )
        if (result === 'func') smoothedCount++
        else shapeCount++
      } else {
        yUpdateStrokePoints(id, smoothed)
        smoothedCount++
      }
    }
  }

  const totalMs = (performance.now() - t0).toFixed(1)
  console.log(
    `%c[beautify] %cdone %c${totalMs}ms %cshapes=${shapeCount} smoothed=${smoothedCount}`,
    'color:#8b5cf6;font-weight:bold', '', 'color:#a1a1aa', '', '',
  )

  return strokeIds.length
}
