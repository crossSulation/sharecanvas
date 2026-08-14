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

    const pts: Pt[] = st.points.map((p) => {
      if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
        return { x: (p as { x: number; y: number }).x, y: (p as { x: number; y: number }).y }
      }
      return { x: 0, y: 0 }
    }).filter((p) => isFinite(p.x) && isFinite(p.y))

    if (pts.length < 3) continue

    const smoothed = smoothPoints(pts, 2)
    const detected = detectShape(smoothed)
    if (detected && detected.confidence > 0.6 && pts.length > 10) {
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
  kind: 'rect' | 'ellipse' | 'trapezoid' | 'pentagon' | 'hexagon' | 'heptagon' | 'octagon' | 'diamond' | 'parallelogram' | 'arrow' | 'line' | 'linear' | 'quadratic'
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
  funcParams?: number[]
}

function hasArrowhead(points: Pt[], first: Pt, last: Pt): boolean {
  if (points.length < 10) return false
  const dx = last.x - first.x
  const dy = last.y - first.y
  const len2 = dx * dx + dy * dy
  if (len2 < 400) return false

  // 中间段偏离度
  const midStart = Math.floor(points.length / 3)
  const midEnd = Math.floor(points.length * 2 / 3)
  let midDev = 0, midCount = 0
  for (let i = midStart; i < midEnd; i++) {
    const t = ((points[i]!.x - first.x) * dx + (points[i]!.y - first.y) * dy) / len2
    midDev += Math.hypot(points[i]!.x - (first.x + t * dx), points[i]!.y - (first.y + t * dy))
    midCount++
  }
  const midAvg = midCount > 0 ? midDev / midCount : 0

  // 末端 20% 偏离度
  const endStart = Math.max(Math.floor(points.length * 0.8), midEnd)
  let endDev = 0, endCount = 0
  for (let i = endStart; i < points.length; i++) {
    const t = ((points[i]!.x - first.x) * dx + (points[i]!.y - first.y) * dy) / len2
    endDev += Math.hypot(points[i]!.x - (first.x + t * dx), points[i]!.y - (first.y + t * dy))
    endCount++
  }
  const endAvg = endCount > 0 ? endDev / endCount : 0

  return endAvg > midAvg * 2.5 && endAvg > 8
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
  if (lineConf > 0.65) {
    const isArrow = hasArrowhead(points, first, last)
    return { kind: isArrow ? 'arrow' : 'line', x0: first.x, y0: first.y, x1: last.x, y1: last.y, confidence: lineConf }
  }

  // 函数曲线优先：R² 强拟合（线性 >0.92 / 二次 >0.88）与形状不冲突，
  // 避免抛物线等被误判成形状类
  const linConf = evalLinear(points)
  if (linConf.r2 > 0.92) {
    const range = w
    const sx = range < 50 ? minX - 10 : minX
    const ex = range < 50 ? maxX + 10 : maxX
    return { kind: 'linear', x0: sx, y0: linConf.a * sx + linConf.b, x1: ex, y1: linConf.a * ex + linConf.b, confidence: linConf.r2, funcParams: [linConf.a, linConf.b] }
  }

  const quadConf = evalQuadratic(points)
  if (quadConf.r2 > 0.88) {
    const range = w
    const sx = range < 50 ? minX - 5 : minX
    const ex = range < 50 ? maxX + 5 : maxX
    const sy = quadConf.a * sx * sx + quadConf.b * sx + quadConf.c
    const ey = quadConf.a * ex * ex + quadConf.b * ex + quadConf.c
    return { kind: 'quadratic', x0: sx, y0: sy, x1: ex, y1: ey, confidence: quadConf.r2, funcParams: [quadConf.a, quadConf.b, quadConf.c] }
  }

  const aspectRatio = w / Math.max(h, 1)

  const diamondConf = evalDiamond(points, bbox)
  if (diamondConf > 0.65 && aspectRatio > 0.25 && aspectRatio < 4.0) {
    return { kind: 'diamond', x0: minX, y0: minY, x1: maxX, y1: maxY, confidence: diamondConf }
  }

  const rectConf = evalRect(points, bbox)
  if (rectConf > 0.7 && aspectRatio > 0.3 && aspectRatio < 3) {
    return { kind: 'rect', ...bbox, confidence: rectConf }
  }

  const circConf = evalCircle(points, bbox)
  if (circConf > 0.6 && aspectRatio > 0.4 && aspectRatio < 2.5) {
    return { kind: 'ellipse', ...bbox, confidence: circConf }
  }

  const trapConf = evalTrapezoid(points, { x0: minX, y0: minY, x1: maxX, y1: maxY })
  if (trapConf > 0.5 && aspectRatio > 0.4 && aspectRatio < 3.5) {
    return { kind: 'trapezoid', x0: minX, y0: minY, x1: maxX, y1: maxY, confidence: trapConf }
  }

  const paraConf = evalParallelogram(points, { x0: minX, y0: minY, x1: maxX, y1: maxY })
  if (paraConf > 0.6 && aspectRatio > 0.5 && aspectRatio < 3.5) {
    return { kind: 'parallelogram', x0: minX, y0: minY, x1: maxX, y1: maxY, confidence: paraConf }
  }

  const hexConf = evalHexagon(points, { x0: minX, y0: minY, x1: maxX, y1: maxY })
  if (hexConf > 0.55 && aspectRatio > 0.5 && aspectRatio < 2.0) {
    return { kind: 'hexagon', x0: minX, y0: minY, x1: maxX, y1: maxY, confidence: hexConf }
  }

  // 多边形检测：五边形(5)/七边形(7)/八边形(8)
  for (const sides of [5, 7, 8]) {
    const ngonConf = evalNgon(points, { x0: minX, y0: minY, x1: maxX, y1: maxY }, sides)
    if (ngonConf > 0.55 && aspectRatio > 0.5 && aspectRatio < 2.0) {
      const kind = sides === 5 ? 'pentagon' : sides === 7 ? 'heptagon' : 'octagon'
      return { kind, x0: minX, y0: minY, x1: maxX, y1: maxY, confidence: ngonConf }
    }
  }

  return null
}

function evalLine(points: Pt[], first: Pt, last: Pt): number {
  if (points.length < 3) return 1
  const dx = last.x - first.x
  const dy = last.y - first.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1) return 0
  let sumSq = 0
  for (let i = 1; i < points.length - 1; i++) {
    const t = ((points[i]!.x - first.x) * dx + (points[i]!.y - first.y) * dy) / len2
    const projX = first.x + t * dx
    const projY = first.y + t * dy
    sumSq += (points[i]!.x - projX) ** 2 + (points[i]!.y - projY) ** 2
  }
  const rms = Math.sqrt(sumSq / (points.length - 2))
  const lineLen = Math.sqrt(len2)
  return Math.max(0, 1 - rms / Math.max(lineLen * 0.3, 5))
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
    const nearX = Math.abs(dx - hw) < Math.max(hw * 0.18, 5)
    const nearY = Math.abs(dy - hh) < Math.max(hh * 0.18, 5)
    if ((nearX && dy < hh * 0.7) || (nearY && dx < hw * 0.7) || (nearX && nearY)) onEdge++
  }
  return onEdge / points.length
}

function evalCircle(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const rx = (bbox.x1 - bbox.x0) / 2
  const ry = (bbox.y1 - bbox.y0) / 2
  if (rx < 3 || ry < 3) return 0

  let sumSq = 0
  for (const p of points) {
    const v = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2
    sumSq += (Math.sqrt(v) - 1) ** 2
  }
  const rms = Math.sqrt(sumSq / points.length)
  return Math.max(0, 1 - rms / 0.4)
}

function evalDiamond(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const hw = (bbox.x1 - bbox.x0) / 2
  const hh = (bbox.y1 - bbox.y0) / 2
  if (hw < 3 || hh < 3) return 0

  let sumSq = 0
  for (const p of points) {
    const dx = Math.abs(p.x - cx)
    const dy = Math.abs(p.y - cy)
    const diamondDist = dx / hw + dy / hh
    sumSq += (diamondDist - 1) ** 2
  }
  const rms = Math.sqrt(sumSq / points.length)
  return Math.max(0, 1 - rms / 0.5)
}

function evalParallelogram(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = bbox.x1 - bbox.x0
  const h = bbox.y1 - bbox.y0
  if (w < 10 || h < 10) return 0
  const skew = w * 0.25
  const verts = [
    { x: bbox.x0 + skew, y: bbox.y0 },
    { x: bbox.x1, y: bbox.y0 },
    { x: bbox.x1 - skew, y: bbox.y1 },
    { x: bbox.x0, y: bbox.y1 },
  ]
  let onEdge = 0
  for (const p of points) {
    for (let i = 0; i < 4; i++) {
      const a = verts[i]!
      const b = verts[(i + 1) % 4]!
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      if (len2 < 1) continue
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const px = a.x + t * dx, py = a.y + t * dy
      if (Math.hypot(p.x - px, p.y - py) < Math.max(w * 0.2, 10)) { onEdge++; break }
    }
  }
  return onEdge / points.length
}

function evalHexagon(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const r = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) / 2
  if (r < 10) return 0
  let sumSq = 0
  for (const p of points) {
    const angle = Math.atan2(p.y - cy, p.x - cx)
    const sector = (angle + Math.PI) / (Math.PI * 2) * 6
    const hexAngle = Math.round(sector) * Math.PI / 3
    const hx = cx + r * Math.cos(hexAngle)
    const hy = cy + r * Math.sin(hexAngle)
    sumSq += (p.x - hx) ** 2 + (p.y - hy) ** 2
  }
  const rms = Math.sqrt(sumSq / points.length)
  return Math.max(0, 1 - rms / (r * 0.4))
}

function evalLinear(points: Pt[]): { a: number; b: number; r2: number } {
  const n = points.length
  if (n < 3) return { a: 0, b: 0, r2: 0 }
  // 数值稳定性：先居中（世界坐标可能远离 0，normal equations 病态）
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  let sx = 0, sy = 0, sxy = 0, sx2 = 0
  for (const p of points) {
    const x = p.x - mx, y = p.y - my
    sx += x; sy += y
    sxy += x * y; sx2 += x * x
  }
  const denom = n * sx2 - sx * sx
  if (Math.abs(denom) < 1e-12) return { a: 0, b: 0, r2: 0 }
  const a = (n * sxy - sx * sy) / denom
  const b = (sy - a * sx) / n - a * mx + my // 反居中：y = a(x-mx) + b' + my → y = ax + b
  const yMean = my
  let ssRes = 0, ssTot = 0
  for (const p of points) {
    const yPred = a * p.x + b
    ssRes += (p.y - yPred) ** 2
    ssTot += (p.y - yMean) ** 2
  }
  const r2 = ssTot < 1e-12 ? 0 : 1 - ssRes / ssTot
  return { a, b, r2: Math.max(0, r2) }
}

function fitQuadratic(points: Pt[]): { a: number; b: number; c: number; r2: number } {
  const n = points.length
  if (n < 5) return { a: 0, b: 0, c: 0, r2: 0 }
  // 数值稳定性：先居中（世界坐标可能远离 0，x² 达 1e5，normal equations 病态）
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0
  let sy = 0, sxy = 0, sx2y = 0
  for (const p of points) {
    const x = p.x - mx, x2 = x * x, x3 = x2 * x, x4 = x3 * x
    const y = p.y - my
    sx += x; sx2 += x2; sx3 += x3; sx4 += x4
    sy += y; sxy += x * y; sx2y += x2 * y
  }
  const d = n * (sx2 * sx4 - sx3 * sx3) - sx * (sx * sx4 - sx2 * sx3) + sx2 * (sx * sx3 - sx2 * sx2)
  if (Math.abs(d) < 1e-12) return { a: 0, b: 0, c: 0, r2: 0 }
  const ap = (n * (sx2 * sx2y - sx3 * sxy) - sx * (sx * sx2y - sx3 * sy) + sx2 * (sx * sxy - sx2 * sy)) / d
  const bp = (n * (sx4 * sxy - sx3 * sx2y) - sx * (sx4 * sy - sx2 * sx2y) + sx2 * (sx3 * sy - sx * sx2y)) / d
  const cp = (sy - ap * sx2 - bp * sx) / n
  // 反居中：y = ap(x-mx)^2 + bp(x-mx) + cp + my
  const a = ap
  const b = bp - 2 * ap * mx
  const c = ap * mx * mx - bp * mx + cp + my
  const yMean = my
  let ssRes = 0, ssTot = 0
  for (const p of points) {
    const yPred = a * p.x * p.x + b * p.x + c
    ssRes += (p.y - yPred) ** 2
    ssTot += (p.y - yMean) ** 2
  }
  const r2 = ssTot < 1e-12 ? 0 : 1 - ssRes / ssTot
  return { a, b, c, r2: Math.max(0, r2) }
}

function evalQuadratic(points: Pt[]): { a: number; b: number; c: number; r2: number } {
  if (points.length < 5) return { a: 0, b: 0, c: 0, r2: 0 }
  // 离群点剔除：笔尖误触/起点跳变会显著拉低 R²，最多丢弃 3% 残差最大的点再拟合
  const maxDrop = Math.ceil(points.length * 0.03)
  let pts = points
  let best = fitQuadratic(pts)
  for (let k = 0; k < maxDrop; k++) {
    if (best.r2 > 0.88 || pts.length < 6) break
    let worst = 0
    let worstErr = -1
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      const err = Math.abs(p.y - (best.a * p.x * p.x + best.b * p.x + best.c))
      if (err > worstErr) {
        worstErr = err
        worst = i
      }
    }
    pts = pts.filter((_, i) => i !== worst)
    best = fitQuadratic(pts)
  }
  return best
}

function evalTrapezoid(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = bbox.x1 - bbox.x0
  const h = bbox.y1 - bbox.y0
  if (w < 15 || h < 15) return 0
  const cx = (bbox.x0 + bbox.x1) / 2
  const ratios = [0.45, 0.55, 0.65, 0.75]
  let best = 0
  for (const ratio of ratios) {
    const topHw = w * ratio / 2
    const verts = [
      { x: cx - topHw, y: bbox.y0 },
      { x: cx + topHw, y: bbox.y0 },
      { x: bbox.x1, y: bbox.y1 },
      { x: bbox.x0, y: bbox.y1 },
    ]
    let onEdge = 0
    for (const p of points) {
      for (let i = 0; i < 4; i++) {
        const a = verts[i]!
        const b = verts[(i + 1) % 4]!
        const dx = b.x - a.x, dy = b.y - a.y
        const len2 = dx * dx + dy * dy
        if (len2 < 1) continue
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
        t = Math.max(0, Math.min(1, t))
        const px = a.x + t * dx, py = a.y + t * dy
        if (Math.hypot(p.x - px, p.y - py) < w * 0.12) { onEdge++; break }
      }
    }
    const conf = onEdge / points.length
    if (conf > best) best = conf
  }
  return best
}

function evalNgon(points: Pt[], bbox: { x0: number; y0: number; x1: number; y1: number }, sides: number): number {
  const cx = (bbox.x0 + bbox.x1) / 2
  const cy = (bbox.y0 + bbox.y1) / 2
  const r = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) / 2
  if (r < 10) return 0
  let sumSq = 0
  for (const p of points) {
    const angle = Math.atan2(p.y - cy, p.x - cx)
    const sector = (angle + Math.PI) / (Math.PI * 2) * sides
    const idx = Math.round(sector) % sides
    const cornerAngle = idx * 2 * Math.PI / sides - Math.PI / sides
    const vx = cx + r * Math.cos(cornerAngle)
    const vy = cy + r * Math.sin(cornerAngle)
    sumSq += (p.x - vx) ** 2 + (p.y - vy) ** 2
  }
  const rms = Math.sqrt(sumSq / points.length)
  return Math.max(0, 1 - rms / (r * 0.4))
}
