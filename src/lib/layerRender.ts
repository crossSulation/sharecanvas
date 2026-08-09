import { getStroke } from 'perfect-freehand'
import type { StrokeOptions } from 'perfect-freehand'
import type { Doc, Pt, Shape, Stroke, TextItem } from '../types'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

interface BrushPreset {
  sizeScale?: number
  thinning?: number
  smoothing?: number
  streamline?: number
  taper: number | boolean
  opacity?: number
}

// 各笔型的 perfect-freehand 参数（主线程与 Worker 共用，保证各端渲染一致）
const BRUSH_PRESETS: Record<string, BrushPreset> = {
  pen: { thinning: 0.65, smoothing: 0.55, streamline: 0.45, taper: 0.6 },
  brush: { thinning: 0.85, smoothing: 0.6, streamline: 0.35, taper: 0.85 },
  marker: { thinning: 0.25, smoothing: 0.5, streamline: 0.4, taper: 0, sizeScale: 1.6, opacity: 0.4 },
  pencil: { thinning: 0.4, smoothing: 0.6, streamline: 0.3, taper: 0.4, sizeScale: 0.8, opacity: 0.55 },
  highlighter: { thinning: 0.2, smoothing: 0.5, streamline: 0.4, taper: 0, opacity: 0.35 },
}

export function brushPreset(kind: string): BrushPreset {
  return BRUSH_PRESETS[kind] ?? BRUSH_PRESETS.pen
}

// perfect-freehand：把带压感的点序列转成平滑的可变宽度轮廓
function strokeOutline(pts: Pt[], s: Stroke): number[][] {
  const hasPressure = pts.some((p) => p.p !== undefined)
  const preset = brushPreset(s.kind)
  const options: StrokeOptions = {
    size: s.size * (preset.sizeScale ?? 1),
    thinning: preset.thinning,
    smoothing: preset.smoothing,
    streamline: preset.streamline,
    simulatePressure: !hasPressure,
    start: { cap: true, taper: preset.taper },
    end: { cap: true, taper: preset.taper },
  }
  return getStroke(
    pts.map((p) => [p.x, p.y, p.p ?? 0.5] as [number, number, number]),
    options,
  )
}

export function drawStroke(ctx: Ctx2D, s: Stroke, alpha: number): void {
  const preset = brushPreset(s.kind)
  const effSize = s.size * (preset.sizeScale ?? 1)
  ctx.globalAlpha = alpha * (preset.opacity ?? s.opacity)
  ctx.fillStyle = s.color
  if (s.points.length === 1) {
    ctx.beginPath()
    ctx.arc(
      s.points[0].x,
      s.points[0].y,
      Math.max(0.5, (effSize * (0.3 + 0.7 * (s.points[0].p ?? 1))) / 2),
      0,
      Math.PI * 2,
    )
    ctx.fill()
  } else {
    const outline = strokeOutline(s.points, s)
    if (outline.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(outline[0][0], outline[0][1])
      for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1])
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

export function shapeCenter(sh: Shape): Pt {
  return {
    x: (Math.min(sh.x0, sh.x1) + Math.max(sh.x0, sh.x1)) / 2,
    y: (Math.min(sh.y0, sh.y1) + Math.max(sh.y0, sh.y1)) / 2,
  }
}

export function polygonPoints(sh: Shape): Pt[] {
  const x0 = Math.min(sh.x0, sh.x1)
  const x1 = Math.max(sh.x0, sh.x1)
  const y0 = Math.min(sh.y0, sh.y1)
  const y1 = Math.max(sh.y0, sh.y1)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const w = x1 - x0
  const h = y1 - y0
  switch (sh.kind) {
    case 'triangle': {
      const top = { x: cx, y: y0 }
      const bl = { x: x0, y: y1 }
      const br = { x: x1, y: y1 }
      return [top, br, bl]
    }
    case 'star': {
      const outR = Math.min(w, h) / 2
      const inR = outR * 0.45
      const pts: Pt[] = []
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + (Math.PI * 2 * i) / 5
        pts.push({ x: cx + outR * Math.cos(a), y: cy - outR * Math.sin(a) })
        pts.push({ x: cx + inR * Math.cos(a + Math.PI / 5), y: cy - inR * Math.sin(a + Math.PI / 5) })
      }
      return pts
    }
    case 'diamond':
      return [
        { x: cx, y: y0 },
        { x: x1, y: cy },
        { x: cx, y: y1 },
        { x: x0, y: cy },
      ]
    case 'parallelogram': {
      const slant = h * 0.25
      return [
        { x: x0 + slant, y: y0 },
        { x: x1, y: y0 },
        { x: x1 - slant, y: y1 },
        { x: x0, y: y1 },
      ]
    }
    case 'hexagon':
      return [
        { x: x0 + w / 4, y: y0 },
        { x: x1 - w / 4, y: y0 },
        { x: x1, y: cy },
        { x: x1 - w / 4, y: y1 },
        { x: x0 + w / 4, y: y1 },
        { x: x0, y: cy },
      ]
    default:
      return []
  }
}

function outlinePoints(sh: Shape): Pt[] {
  if (sh.kind === 'triangle' || sh.kind === 'star' || sh.kind === 'diamond' || sh.kind === 'parallelogram' || sh.kind === 'hexagon') {
    return polygonPoints(sh)
  }
  const x0 = Math.min(sh.x0, sh.x1)
  const x1 = Math.max(sh.x0, sh.x1)
  const y0 = Math.min(sh.y0, sh.y1)
  const y1 = Math.max(sh.y0, sh.y1)
  if (sh.kind === 'rect' || sh.kind === 'roundrect') {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]
  }
  if (sh.kind === 'ellipse') {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const rx = Math.max(0.1, (x1 - x0) / 2)
    const ry = Math.max(0.1, (y1 - y0) / 2)
    const pts: Pt[] = []
    const n = 48
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) })
    }
    return pts
  }
  return []
}

function raySegment(p: Pt, d: Pt, a: Pt, b: Pt): Pt | null {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const denom = d.x * vy - d.y * vx
  if (Math.abs(denom) < 1e-9) return null
  const t = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / denom
  const u = ((a.x - p.x) * vy - (a.y - p.y) * vx) / denom
  if (t < 0 || t > 1 || u < 0) return null
  return { x: a.x + t * vx, y: a.y + t * vy }
}

// 从图形中心朝 target 方向的射线与图形轮廓的交点（箭头吸附用）
export function shapeEdgePoint(sh: Shape, target: Pt): Pt {
  const c = shapeCenter(sh)
  const dx = target.x - c.x
  const dy = target.y - c.y
  const len = Math.hypot(dx, dy)
  if (len < 0.001) return c
  const pts = outlinePoints(sh)
  if (!pts.length) return c
  const d = { x: dx / len, y: dy / len }
  let best: Pt | null = null
  let bestDist = Infinity
  for (let i = 0; i < pts.length; i++) {
    const hit = raySegment(c, d, pts[i], pts[(i + 1) % pts.length])
    if (hit) {
      const dist = Math.hypot(hit.x - c.x, hit.y - c.y)
      if (dist < bestDist) {
        bestDist = dist
        best = hit
      }
    }
  }
  return best ?? c
}

export function shapeEndpoints(sh: Shape, doc: Doc): { start: Pt; end: Pt } {
  let start = { x: sh.x0, y: sh.y0 }
  let end = { x: sh.x1, y: sh.y1 }
  const sShape = sh.attachStartId ? doc.shapes.find((x) => x.id === sh.attachStartId) : undefined
  const eShape = sh.attachEndId ? doc.shapes.find((x) => x.id === sh.attachEndId) : undefined
  if (sShape) start = shapeEdgePoint(sShape, end)
  if (eShape) end = shapeEdgePoint(eShape, start)
  if (sShape && eShape) start = shapeEdgePoint(sShape, end)
  return { start, end }
}

export function textWorldPos(t: TextItem, doc: Doc): Pt {
  if (t.attachId) {
    const sh = doc.shapes.find((x) => x.id === t.attachId)
    if (sh) return shapeCenter(sh)
  }
  return { x: t.x, y: t.y }
}

export function drawShape(ctx: Ctx2D, sh: Shape, doc: Doc): void {
  ctx.strokeStyle = sh.color
  ctx.lineWidth = sh.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (sh.kind === 'rect' || sh.kind === 'roundrect') {
    const x = Math.min(sh.x0, sh.x1)
    const y = Math.min(sh.y0, sh.y1)
    const w = Math.abs(sh.x1 - sh.x0)
    const h = Math.abs(sh.y1 - sh.y0)
    if (sh.kind === 'roundrect') {
      const r = Math.min(w, h) * 0.25
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    } else {
      ctx.rect(x, y, w, h)
    }
  } else if (sh.kind === 'ellipse') {
    ctx.ellipse(
      (sh.x0 + sh.x1) / 2,
      (sh.y0 + sh.y1) / 2,
      Math.abs(sh.x1 - sh.x0) / 2,
      Math.abs(sh.y1 - sh.y0) / 2,
      0,
      0,
      Math.PI * 2,
    )
  } else if (sh.kind === 'triangle' || sh.kind === 'star' || sh.kind === 'diamond' || sh.kind === 'parallelogram' || sh.kind === 'hexagon') {
    const pts = polygonPoints(sh)
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
  } else {
    const { start, end } = shapeEndpoints(sh, doc)
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    if (sh.kind === 'arrow') {
      const angle = Math.atan2(end.y - start.y, end.x - start.x)
      const len = 12 + sh.size * 1.5
      ctx.moveTo(end.x, end.y)
      ctx.lineTo(end.x - len * Math.cos(angle - Math.PI / 7), end.y - len * Math.sin(angle - Math.PI / 7))
      ctx.moveTo(end.x, end.y)
      ctx.lineTo(end.x - len * Math.cos(angle + Math.PI / 7), end.y - len * Math.sin(angle + Math.PI / 7))
    }
  }
  ctx.stroke()
}

export function drawText(ctx: Ctx2D, t: TextItem, doc: Doc, alpha: number): void {
  const pos = textWorldPos(t, doc)
  ctx.fillStyle = t.color
  ctx.font = `${t.size}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.globalAlpha = alpha
  if (t.attachId) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(t.text, pos.x, pos.y)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  } else {
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(t.text, pos.x, pos.y)
  }
  ctx.globalAlpha = 1
}

// 绘制某层的全部内容（含本层擦除洞），供主线程与渲染 Worker 共用
export function drawLayerContent(
  ctx: Ctx2D,
  doc: Doc,
  layerId: string,
  layerOpacity: number,
  layerOf: (l?: string) => string,
): void {
  const holesAfter = (seq: number) => {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    for (const c of doc.eraser) {
      if (c.seq <= seq || layerOf(c.layer) !== layerId) continue
      ctx.beginPath()
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  for (const s of doc.strokes) {
    if (layerOf(s.layer) !== layerId) continue
    drawStroke(ctx, s, layerOpacity)
    holesAfter(s.seq ?? 0)
  }
  for (const sh of doc.shapes) {
    if (layerOf(sh.layer) !== layerId) continue
    ctx.globalAlpha = layerOpacity
    drawShape(ctx, sh, doc)
    ctx.globalAlpha = 1
    holesAfter(sh.seq ?? 0)
  }
  for (const t of doc.texts) {
    if (layerOf(t.layer) !== layerId) continue
    drawText(ctx, t, doc, layerOpacity)
    holesAfter(t.seq ?? 0)
  }
}
