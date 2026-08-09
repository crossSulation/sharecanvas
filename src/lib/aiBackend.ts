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
  const hasTauri = !!(window as any).__TAURI_INTERNALS__
  if (hasTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const path = await invoke<string>('log_file_path')
      console.log('%c[AI] log file (tauri): %c%s', 'color:#a1a1aa', 'color:#3b82f6', path || '(empty — path not set)')
    } catch (e) {
      console.log('%c[AI] tauri log path error: %c%s', 'color:#a1a1aa', 'color:#f87171', String(e))
    }
    return
  }

  try {
    const res = await fetch('/api/ai/log-path')
    const { path } = await res.json()
    console.log('%c[AI] log file (server): %c%s', 'color:#a1a1aa', 'color:#22c55e', path || '(empty)')
  } catch {
    console.log('%c[AI] log: %crunning in browser, no file log', 'color:#a1a1aa', 'color:#a1a1aa')
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

  // 收集所有选中笔画的点，按笔画顺序拼接
  const allPts: Pt[] = []
  const firstStroke = s.doc.strokes.find((st) => st.id === strokeIds[0])
  const refColor = firstStroke?.color ?? '#18181b'
  const refSize = firstStroke?.size ?? 4
  const refLayer = firstStroke?.layer
  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 2) continue
    const pts = extractPoints(st.points)
    for (const p of pts) allPts.push(p)
  }
  if (allPts.length < 4) {
    // 点太少，逐个平滑即可
    for (const id of strokeIds) {
      const st = s.doc.strokes.find((x) => x.id === id)
      if (!st || st.points.length < 3) continue
      const pts = extractPoints(st.points)
      if (pts.length < 3) continue
      yUpdateStrokePoints(id, smoothPoints(pts, 2))
    }
    return strokeIds.length
  }

  console.log(
    `%c[beautify] %cpath=%c${pathLabel} %cstrokes=%c${strokeIds.length} %crefined into %c${allPts.length} points`,
    'color:#8b5cf6;font-weight:bold', '', 'color:#3b82f6', '', 'color:#18181b;font-weight:bold', '', 'color:#18181b',
  )

  const t1 = performance.now()
  let smoothedCount = 0
  let shapeCount = 0

  if (backend) {
    const result = await backend.beautify_stroke({ points: allPts })
    const smoothed = result.points as Pt[]
    const detected = result.detectedShape as { kind: string; x0: number; y0: number; x1: number; y1: number; confidence: number; funcParams?: number[] } | null

    if (detected && detected.confidence > 0.15 && allPts.length > 10) {
      const outcome = handleDetected(strokeIds[0]!, detected, refColor, refSize, refLayer)
      // 删除其他笔画
      if (strokeIds.length > 1) yDeleteItems('strokes', strokeIds.slice(1))
      console.log(
        `  %c→ ${outcome} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
        outcome === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
      )
      if (outcome === 'func') smoothedCount++
      else shapeCount++
    } else {
      // 未识别为形状 → 平滑合并点，更新到第一笔，删除其余
      // 按原始笔画顺序分配平滑点
      let offset = 0
      for (const id of strokeIds) {
        const st = s.doc.strokes.find((x) => x.id === id)
        if (!st) continue
        const origLen = st.points.length
        if (origLen < 2) continue
        // 平滑后的对应段
        const tStart = offset / Math.max(allPts.length - 1, 1)
        const tEnd = (offset + origLen - 1) / Math.max(allPts.length - 1, 1)
        const segPts: Pt[] = []
        const segN = Math.max(origLen, 3)
        for (let i = 0; i < segN; i++) {
          const si = Math.round(tStart * (smoothed.length - 1) + i * (tEnd - tStart) * (smoothed.length - 1) / Math.max(segN - 1, 1))
          if (si >= 0 && si < smoothed.length) segPts.push(smoothed[si]!)
        }
        yUpdateStrokePoints(id, segPts.length >= 2 ? segPts : smoothed)
        smoothedCount++
        offset += origLen
      }
    }
  } else {
    const smoothed = smoothPoints(allPts, 2)
    const detected = detectShape(smoothed)

    if (detected && detected.confidence > 0.15 && allPts.length > 10) {
      const outcome = handleDetected(strokeIds[0]!, detected, refColor, refSize, refLayer)
      if (strokeIds.length > 1) yDeleteItems('strokes', strokeIds.slice(1))
      console.log(
        `  %c→ ${outcome} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
        outcome === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
      )
      if (outcome === 'func') smoothedCount++
      else shapeCount++
    } else {
      // 未识别 → 平滑各段
      let offset = 0
      for (const id of strokeIds) {
        const st = s.doc.strokes.find((x) => x.id === id)
        if (!st) continue
        const origLen = st.points.length
        if (origLen < 2) continue
        const tStart = offset / Math.max(allPts.length - 1, 1)
        const tEnd = (offset + origLen - 1) / Math.max(allPts.length - 1, 1)
        const segPts: Pt[] = []
        const segN = Math.max(origLen, 3)
        for (let i = 0; i < segN; i++) {
          const si = Math.round(tStart * (smoothed.length - 1) + i * (tEnd - tStart) * (smoothed.length - 1) / Math.max(segN - 1, 1))
          if (si >= 0 && si < smoothed.length) segPts.push(smoothed[si]!)
        }
        yUpdateStrokePoints(id, segPts.length >= 2 ? segPts : smoothed)
        smoothedCount++
        offset += origLen
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
