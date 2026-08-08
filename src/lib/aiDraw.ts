import type { Pt } from '../types'
import { yDeleteItems, yPush, yUpdateStrokePoints } from './yroom'
import { createId } from './id'
import { nextSeq } from './seq'
import { useStore } from '../store'

export function beautifySelected() {
  const s = useStore.getState()
  const strokeIds = s.selected.filter((id) => s.doc.strokes.some((st) => st.id === id))
  if (!strokeIds.length) return

  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 3) continue

    const pts = smoothPoints(st.points.map((p) =>
      (typeof p === 'object' && 'x' in p ? { x: p.x, y: p.y } : p) as Pt
    ), 2)

    const detected = detectShape(pts)
    if (detected && detected.confidence > 0.82 && pts.length > 8) {
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
      yUpdateStrokePoints(id, pts)
    }
  }
}

export function smoothPoints(points: Pt[], passes = 2): Pt[] {
  if (points.length < 3) return points
  let result = points
  for (let p = 0; p < passes; p++) {
    const smoothed: Pt[] = [result[0]!]
    for (let i = 1; i < result.length - 1; i++) {
      const prev = result[i - 1]!
      const curr = result[i]!
      const next = result[i + 1]!
      smoothed.push({
        x: prev.x * 0.25 + curr.x * 0.5 + next.x * 0.25,
        y: prev.y * 0.25 + curr.y * 0.5 + next.y * 0.25,
      })
    }
    smoothed.push(result[result.length - 1]!)
    result = smoothed
  }
  return result
}

export interface DetectedShape {
  kind: 'rect' | 'ellipse' | 'diamond' | 'arrow' | 'line'
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
}

export function detectShape(points: Pt[]): DetectedShape | null {
  if (points.length < 4) return null

  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const w = maxX - minX
  const h = maxY - minY

  if (w < 5 && h < 5) return null

  const bbox = { x0: minX, y0: minY, x1: maxX, y1: maxY }
  const first = points[0]!
  const last = points[points.length - 1]!

  const lineConf = evalLine(points, first, last)
  if (lineConf > 0.85) {
    const angle = Math.atan2(last.y - first.y, last.x - first.x) * (180 / Math.PI)
    const dist = Math.hypot(last.x - first.x, last.y - first.y)
    if (angle > -30 && angle < 30 && dist > 30) {
      return { kind: 'arrow', x0: first.x, y0: first.y, x1: last.x, y1: last.y, confidence: lineConf }
    }
    return { kind: 'line', x0: first.x, y0: first.y, x1: last.x, y1: last.y, confidence: lineConf }
  }

  const aspectRatio = w / Math.max(h, 1)

  const rectConf = evalRect(points, bbox)
  if (rectConf > 0.7 && aspectRatio > 0.3 && aspectRatio < 3) {
    return { kind: 'rect', ...bbox, confidence: rectConf }
  }

  const circConf = evalCircle(points, bbox)
  if (circConf > 0.6 && aspectRatio > 0.4 && aspectRatio < 2.5) {
    return { kind: 'ellipse', ...bbox, confidence: circConf }
  }

  const diamondConf = evalDiamond(points, bbox)
  if (diamondConf > 0.65 && aspectRatio > 0.4 && aspectRatio < 2.5) {
    return { kind: 'diamond', ...bbox, confidence: diamondConf }
  }

  return null
}

function evalLine(points: Pt[], first: Pt, last: Pt): number {
  if (points.length < 3) return 1
  const dx = last.x - first.x
  const dy = last.y - first.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1) return 0
  let totalDist = 0
  for (let i = 1; i < points.length - 1; i++) {
    const t = ((points[i]!.x - first.x) * dx + (points[i]!.y - first.y) * dy) / len2
    const projX = first.x + t * dx
    const projY = first.y + t * dy
    totalDist += Math.hypot(points[i]!.x - projX, points[i]!.y - projY)
  }
  const avgDev = totalDist / (points.length - 2)
  const lineLen = Math.sqrt(len2)
  return Math.max(0, 1 - avgDev / Math.max(lineLen * 0.3, 5))
}

function evalRect(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const hw = (bbox.x1 - bbox.x0) / 2
  const hh = (bbox.y1 - bbox.y0) / 2

  let onEdge = 0
  for (const p of points) {
    const dx = Math.abs(p.x - cx)
    const dy = Math.abs(p.y - cy)
    const edgeX = Math.abs(dx - hw) < Math.max(hw * 0.3, 8)
    const edgeY = Math.abs(dy - hh) < Math.max(hh * 0.3, 8)
    if (edgeX || edgeY) onEdge++
  }
  return onEdge / points.length
}

function evalCircle(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const rx = (bbox.x1 - bbox.x0) / 2
  const ry = (bbox.y1 - bbox.y0) / 2
  if (rx < 3 || ry < 3) return 0

  let totalDev = 0
  for (const p of points) {
    const v = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2
    totalDev += Math.abs(Math.sqrt(v) - 1)
  }
  const avgDev = totalDev / points.length
  return Math.max(0, 1 - avgDev / 0.35)
}

function evalDiamond(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const hw = (bbox.x1 - bbox.x0) / 2
  const hh = (bbox.y1 - bbox.y0) / 2
  if (hw < 3 || hh < 3) return 0

  let totalDev = 0
  for (const p of points) {
    const dx = Math.abs(p.x - cx)
    const dy = Math.abs(p.y - cy)
    const diamondDist = dx / hw + dy / hh
    totalDev += Math.abs(diamondDist - 1)
  }
  const avgDev = totalDev / points.length
  return Math.max(0, 1 - avgDev / 0.4)
}
