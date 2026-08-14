import { getStroke } from 'perfect-freehand'
import type { StrokeOptions } from 'perfect-freehand'
import type { Doc, Pt, Shape, Stroke, TextItem } from '../types'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface WorldRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

function intersects(a: WorldRect, b: WorldRect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0
}

export function strokeBounds(s: Stroke): WorldRect {
  if (!s.points.length) return { x0: 0, y0: 0, x1: 0, y1: 0 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of s.points) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  // perfect-freehand 轮廓会超出点序列；按笔宽放大，避免误裁剪
  const pad = s.size * 1.5
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

export function shapeBounds(sh: Shape): WorldRect {
  // 箭头头部 / 附着图形可能超出 x0..x1，额外加余量
  const pad = sh.size * 2 + 24
  return {
    x0: Math.min(sh.x0, sh.x1) - pad,
    y0: Math.min(sh.y0, sh.y1) - pad,
    x1: Math.max(sh.x0, sh.x1) + pad,
    y1: Math.max(sh.y0, sh.y1) + pad,
  }
}

export function textBounds(t: TextItem): WorldRect {
  const w = t.text.length * t.size * 0.62 + t.size
  return { x0: t.x - w, y0: t.y - t.size * 1.5, x1: t.x + w, y1: t.y + t.size * 0.5 }
}

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
    case 'trapezoid': {
      const topHw = w * 0.5 / 2
      return [
        { x: cx - topHw, y: y0 },
        { x: cx + topHw, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ]
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
    case 'pentagon':
    case 'heptagon':
    case 'octagon': {
      const sides = sh.kind === 'pentagon' ? 5 : sh.kind === 'heptagon' ? 7 : 8
      const r = Math.min(w, h) / 2
      const pts: Pt[] = []
      for (let i = 0; i < sides; i++) {
        const a = Math.PI / 2 + (Math.PI * 2 * i) / sides
        pts.push({ x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) })
      }
      return pts
    }
    default:
      return []
  }
}

// 数学图形：角度（两条射线 + 角弧）
const ANGLE_APERTURE = (Math.PI * 50) / 180
export function angleGeometry(sh: Shape): { v: Pt; ray1: Pt; ray2: Pt; arc: Pt[] } {
  const v = { x: sh.x0, y: sh.y0 }
  const ray1 = { x: sh.x1, y: sh.y1 }
  const angle = Math.atan2(ray1.y - v.y, ray1.x - v.x)
  const r = Math.max(1, Math.hypot(ray1.x - v.x, ray1.y - v.y))
  const ray2 = { x: v.x + r * Math.cos(angle + ANGLE_APERTURE), y: v.y + r * Math.sin(angle + ANGLE_APERTURE) }
  const arcR = r * 0.35
  const arc: Pt[] = []
  const n = 16
  for (let i = 0; i <= n; i++) {
    const a = angle + (ANGLE_APERTURE * i) / n
    arc.push({ x: v.x + arcR * Math.cos(a), y: v.y + arcR * Math.sin(a) })
  }
  return { v, ray1, ray2, arc }
}

// 数学图形：坐标系（带箭头的横纵轴，交点 = bbox 中心）
export function axesGeometry(sh: Shape): { cx: number; cy: number; x0: number; y0: number; x1: number; y1: number } {
  const x0 = Math.min(sh.x0, sh.x1)
  const x1 = Math.max(sh.x0, sh.x1)
  const y0 = Math.min(sh.y0, sh.y1)
  const y1 = Math.max(sh.y0, sh.y1)
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x0, y0, x1, y1 }
}

// 数学图形：抛物线（∪，顶点在 bbox 底边中点，两端到顶边两角）
export function parabolaPoints(sh: Shape): Pt[] {
  const x0 = Math.min(sh.x0, sh.x1)
  const x1 = Math.max(sh.x0, sh.x1)
  const y0 = Math.min(sh.y0, sh.y1)
  const y1 = Math.max(sh.y0, sh.y1)
  const cx = (x0 + x1) / 2
  const denom = (x0 - cx) * (x0 - cx)
  const a = denom > 0.001 ? (y0 - y1) / denom : 0
  const pts: Pt[] = []
  const n = 48
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    pts.push({ x, y: a * (x - cx) * (x - cx) + y1 })
  }
  return pts
}

function outlinePoints(sh: Shape): Pt[] {
  if (sh.kind === 'triangle' || sh.kind === 'star' || sh.kind === 'trapezoid' || sh.kind === 'pentagon' || sh.kind === 'hexagon' || sh.kind === 'heptagon' || sh.kind === 'octagon' || sh.kind === 'diamond' || sh.kind === 'parallelogram') {
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
  if (sh.kind === 'angle') {
    const g = angleGeometry(sh)
    return [g.v, g.ray1, g.ray2, ...g.arc]
  }
  if (sh.kind === 'axes') {
    const g = axesGeometry(sh)
    return [
      { x: g.x0, y: g.cy },
      { x: g.x1, y: g.cy },
      { x: g.cx, y: g.y0 },
      { x: g.cx, y: g.y1 },
    ]
  }
  if (sh.kind === 'parabola') return parabolaPoints(sh)
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
  } else if (sh.kind === 'triangle' || sh.kind === 'star' || sh.kind === 'trapezoid' || sh.kind === 'pentagon' || sh.kind === 'hexagon' || sh.kind === 'heptagon' || sh.kind === 'octagon' || sh.kind === 'diamond' || sh.kind === 'parallelogram') {
    const pts = polygonPoints(sh)
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
  } else if (sh.kind === 'angle') {
    const g = angleGeometry(sh)
    ctx.moveTo(g.v.x, g.v.y)
    ctx.lineTo(g.ray1.x, g.ray1.y)
    ctx.moveTo(g.v.x, g.v.y)
    ctx.lineTo(g.ray2.x, g.ray2.y)
    ctx.moveTo(g.arc[0].x, g.arc[0].y)
    for (let i = 1; i < g.arc.length; i++) ctx.lineTo(g.arc[i].x, g.arc[i].y)
  } else if (sh.kind === 'axes') {
    const g = axesGeometry(sh)
    ctx.moveTo(g.x0, g.cy)
    ctx.lineTo(g.x1, g.cy)
    ctx.moveTo(g.cx, g.y1)
    ctx.lineTo(g.cx, g.y0)
    const len = 10 + sh.size * 1.2
    // 横轴右箭头
    ctx.moveTo(g.x1, g.cy)
    ctx.lineTo(g.x1 - len, g.cy - len * 0.45)
    ctx.moveTo(g.x1, g.cy)
    ctx.lineTo(g.x1 - len, g.cy + len * 0.45)
    // 纵轴上箭头（屏幕向上 = y0）
    ctx.moveTo(g.cx, g.y0)
    ctx.lineTo(g.cx - len * 0.45, g.y0 + len)
    ctx.moveTo(g.cx, g.y0)
    ctx.lineTo(g.cx + len * 0.45, g.y0 + len)
  } else if (sh.kind === 'parabola') {
    const pts = parabolaPoints(sh)
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
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
  view?: WorldRect,
): void {
  const holesAfter = (seq: number) => {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    for (const c of doc.eraser) {
      if (c.seq <= seq || layerOf(c.layer) !== layerId) continue
      if (view && !intersects(view, { x0: c.x - c.r, y0: c.y - c.r, x1: c.x + c.r, y1: c.y + c.r })) continue
      ctx.beginPath()
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  for (const s of doc.strokes) {
    if (layerOf(s.layer) !== layerId) continue
    if (view && !intersects(view, strokeBounds(s))) continue
    drawStroke(ctx, s, layerOpacity)
    holesAfter(s.seq ?? 0)
  }
  for (const sh of doc.shapes) {
    if (layerOf(sh.layer) !== layerId) continue
    if (view && !intersects(view, shapeBounds(sh))) continue
    ctx.globalAlpha = layerOpacity
    drawShape(ctx, sh, doc)
    ctx.globalAlpha = 1
    holesAfter(sh.seq ?? 0)
  }
  for (const t of doc.texts) {
    if (layerOf(t.layer) !== layerId) continue
    if (view && !intersects(view, textBounds(t))) continue
    drawText(ctx, t, doc, layerOpacity)
    holesAfter(t.seq ?? 0)
  }
}

// 笔画轮廓点（SVG 导出用），与 drawStroke 的填充轮廓一致
export function strokeOutlinePoints(s: Stroke): Pt[] {
  if (s.points.length === 1) {
    return [{ x: s.points[0].x, y: s.points[0].y }]
  }
  return strokeOutline(s.points, s).map((p) => ({ x: p[0], y: p[1] }))
}
