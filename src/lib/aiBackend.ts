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

async function getBackend(): Promise<BackendAI | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { beautify_stroke: (args: any) => invoke('beautify_stroke', args) }
  } catch {
    return null
  }
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
  const s = useStore.getState()
  const strokeIds = s.selected.filter((id) => s.doc.strokes.some((st) => st.id === id))
  if (!strokeIds.length) return 0

  const backend = await getBackend()
  let count = 0

  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 3) continue

    const pts = extractPoints(st.points)
    if (pts.length < 3) continue

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
      } else {
        yUpdateStrokePoints(id, smoothed)
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
      } else {
        yUpdateStrokePoints(id, smoothed)
      }
    }
    count++
  }
  return count
}
