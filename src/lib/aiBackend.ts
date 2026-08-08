import { smoothPoints, detectShape } from './aiDraw'
import { useStore } from '../store'
import { yDeleteItems, yPush, yUpdateStrokePoints } from './yroom'
import { createId } from './id'
import { nextSeq } from './seq'
import type { Pt } from '../types'

interface BackendAI {
  beautify_stroke(args: { points: { x: number; y: number }[] }): Promise<{
    points: { x: number; y: number }[]
    detected_shape: { kind: string; x0: number; y0: number; x1: number; y1: number; confidence: number } | null
  }>
}

type BackendName = 'tauri' | 'native-server' | 'js-fallback'

async function getBackend(): Promise<{ backend: BackendAI; name: BackendName } | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend: BackendAI = { beautify_stroke: (args: any) => invoke('beautify_stroke', args) }
    return { backend, name: 'tauri' }
  } catch {
    /* not Tauri */
  }

  if (typeof fetch !== 'undefined') {
    try {
      const res = await fetch('/api/health')
      const health = await res.json()
      if (health.ai) {
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
      /* server AI not available */
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
      const detected = result.detected_shape

      if (detected && detected.confidence > 0.85 && pts.length > 10) {
        yDeleteItems('strokes', [id])
        yPush('shapes', [{
          id: createId('sh'),
          kind: detected.kind,
          x0: detected.x0, y0: detected.y0,
          x1: detected.x1, y1: detected.y1,
          color: st.color,
          size: st.size,
          seq: nextSeq(),
          layer: st.layer,
        }])
        shapeCount++
        console.log(
          `  %c→ shape %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
          'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
        )
      } else {
        yUpdateStrokePoints(id, smoothed)
        smoothedCount++
      }
    } else {
      const smoothed = smoothPoints(pts, 2)
      const detected = detectShape(smoothed)

      if (detected && detected.confidence > 0.85 && pts.length > 10) {
        yDeleteItems('strokes', [id])
        yPush('shapes', [{
          id: createId('sh'),
          kind: detected.kind,
          x0: detected.x0, y0: detected.y0,
          x1: detected.x1, y1: detected.y1,
          color: st.color,
          size: st.size,
          seq: nextSeq(),
          layer: st.layer,
        }])
        shapeCount++
        console.log(
          `  %c→ shape %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
          'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
        )
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
