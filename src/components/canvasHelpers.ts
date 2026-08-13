import { drawShape, drawStroke, drawLayerContent, polygonPoints, shapeEndpoints, type WorldRect } from "../lib/layerRender"
import { DEFAULT_LAYER_ID } from "../lib/yroom"
import type { Doc, Pt, Shape, Stroke, TextItem } from "../types"

export type ItemRef = { kind: 'stroke' | 'shape' | 'text'; item: Stroke | Shape | TextItem }

export type Interaction =
  | { type: 'stroke'; stroke: Stroke }
  | { type: 'shape'; id: string; start: Pt; end: Pt }
  | { type: 'erase'; r: number; path: Pt[]; last: number }
  | { type: 'move'; start: Pt; items: ItemRef[]; dx: number; dy: number }
  | { type: 'resize'; start: Pt; startBounds: { x0: number; y0: number; x1: number; y1: number }; handle: ResizeHandle }
  | { type: 'boxselect'; start: Pt; end: Pt }
  | { type: 'lasso'; pts: Pt[] }
  | { type: 'pan'; camStart: { x: number; y: number; zoom: number }; start: Pt }
  | { type: 'pinch'; prevMid: Pt; prevDist: number; camStart: { x: number; y: number; zoom: number } }

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e'

export interface LayerCache {
  canvas: HTMLCanvasElement
  zoom: number
  cam: { x: number; y: number }
  width: number
  height: number
  ready: boolean
}

export interface RasterParams {
  type: 'raster'
  layerId: string
  doc: Doc
  camera: { x: number; y: number }
  zoom: number
  viewport: { w: number; h: number }
  dpr: number
  margin: number
  layerOpacity: number
  defaultLayerId: string
}

export function rasterizeLayerSync(
  existing: LayerCache | undefined,
  doc: Doc,
  layerId: string,
  layerOpacity: number,
  cam: { x: number; y: number },
  zoom: number,
  w: number,
  h: number,
  dpr: number,
  margin: number,
): LayerCache {
  const layerOf = (l?: string) =>
    l && doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID
  const halfW = w / 2 / zoom
  const halfH = h / 2 / zoom
  const left = cam.x - halfW * margin
  const top = cam.y - halfH * margin
  const view: WorldRect = {
    x0: left,
    y0: top,
    x1: left + halfW * margin * 2,
    y1: top + halfH * margin * 2,
  }
  const cw = Math.max(1, Math.ceil(halfW * margin * 2 * zoom * dpr))
  const ch = Math.max(1, Math.ceil(halfH * margin * 2 * zoom * dpr))
  const canvas = existing?.canvas ?? document.createElement('canvas')
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw
    canvas.height = ch
  }
  const octx = canvas.getContext('2d')
  if (octx) {
    octx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0)
    octx.translate(-left, -top)
    octx.clearRect(left, top, halfW * margin * 2, halfH * margin * 2)
    drawLayerContent(octx, doc, layerId, layerOpacity, layerOf, view)
  }
  const cache: LayerCache = existing ?? { canvas, zoom: 0, cam: { x: 0, y: 0 }, width: 0, height: 0, ready: false }
  cache.zoom = zoom
  cache.cam = { x: cam.x, y: cam.y }
  cache.width = cw
  cache.height = ch
  cache.ready = true
  return cache
}

export function drawGestureOverlay(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  it: Interaction | null,
  w: number,
  h: number,
  zoom: number,
  camera: { x: number; y: number },
  dpr: number,
): void {
  if (!it) return
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.translate(w / 2 - camera.x * zoom, h / 2 - camera.y * zoom)
  ctx.scale(zoom, zoom)
  if (it.type === 'stroke') {
    drawStroke(ctx, it.stroke, 1)
  } else if (it.type === 'shape') {
    const sh = doc.shapes.find((x) => x.id === it.id)
    if (sh) drawShape(ctx, sh, doc)
  } else if (it.type === 'move') {
    const dx = it.dx
    const dy = it.dy
    for (const ref of it.items) {
      if (ref.kind === 'stroke') {
        const s = ref.item as Stroke
        drawStroke(
          ctx,
          { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) },
          1,
        )
      } else if (ref.kind === 'shape') {
        const sh = ref.item as Shape
        drawShape(
          ctx,
          { ...sh, x0: sh.x0 + dx, y0: sh.y0 + dy, x1: sh.x1 + dx, y1: sh.y1 + dy },
          doc,
        )
      } else {
        const t = ref.item as TextItem
        ctx.fillStyle = t.color
        ctx.font = `${t.size}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
        ctx.fillText(t.text, t.x + dx, t.y + dy)
      }
    }
  }
  ctx.restore()
}

export function eraserRadius(size: number): number {
  return Math.max(16, size * 2)
}

export const PEN_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 24 24'>" +
  "<path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' fill='#18181b' stroke='#ffffff' stroke-width='1.6' stroke-linejoin='round'/>" +
  "<path d='M5.5 17.5 6.5 18.5' fill='none' stroke='#ffffff' stroke-width='1.5' stroke-linecap='round'/>" +
  '</svg>'

export const PEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PEN_CURSOR_SVG)}") 5 20, crosshair`

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = clamp(t, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function distToPolyline(p: Pt, pts: Pt[]): number {
  if (!pts.length) return Infinity
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y)
  let min = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    min = Math.min(min, distToSegment(p, pts[i], pts[i + 1]))
  }
  return min
}

export function distToPolygon(p: Pt, pts: Pt[]): number {
  if (pts.length < 3) return Infinity
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x
    const yi = pts[i].y
    const xj = pts[j].x
    const yj = pts[j].y
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  if (inside) return 0
  let min = Infinity
  for (let i = 0; i < pts.length; i++) {
    min = Math.min(min, distToSegment(p, pts[i], pts[(i + 1) % pts.length]))
  }
  return min
}

export function editableLayerSet(doc: Doc): (l?: string) => boolean {
  if (!doc.layers.length) return () => true
  const editable = new Set(doc.layers.filter((l) => l.visible && !l.locked).map((l) => l.id))
  return (l?: string) => editable.has(l && doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID)
}

export function shapeDist(p: Pt, sh: Shape, doc?: Doc): number {
  const x0 = Math.min(sh.x0, sh.x1)
  const x1 = Math.max(sh.x0, sh.x1)
  const y0 = Math.min(sh.y0, sh.y1)
  const y1 = Math.max(sh.y0, sh.y1)
  if (sh.kind === 'line' || sh.kind === 'arrow') {
    const { start, end } = doc ? shapeEndpoints(sh, doc) : { start: { x: sh.x0, y: sh.y0 }, end: { x: sh.x1, y: sh.y1 } }
    return distToSegment(p, start, end)
  }
  if (sh.kind === 'rect' || sh.kind === 'roundrect') {
    const inside = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1
    if (inside) return 0
    return Math.min(
      distToSegment(p, { x: x0, y: y0 }, { x: x1, y: y0 }),
      distToSegment(p, { x: x1, y: y0 }, { x: x1, y: y1 }),
      distToSegment(p, { x: x1, y: y1 }, { x: x0, y: y1 }),
      distToSegment(p, { x: x0, y: y1 }, { x: x0, y: y0 }),
    )
  }
  if (sh.kind === 'triangle' || sh.kind === 'star' || sh.kind === 'trapezoid' || sh.kind === 'pentagon' || sh.kind === 'hexagon' || sh.kind === 'heptagon' || sh.kind === 'octagon' || sh.kind === 'diamond' || sh.kind === 'parallelogram') {
    return distToPolygon(p, polygonPoints(sh))
  }
  const cx = (sh.x0 + sh.x1) / 2
  const cy = (sh.y0 + sh.y1) / 2
  const a_ = Math.max(0.001, Math.abs(sh.x1 - sh.x0) / 2)
  const b = Math.max(0.001, Math.abs(sh.y1 - sh.y0) / 2)
  const v = ((p.x - cx) / a_) ** 2 + ((p.y - cy) / b) ** 2
  if (v <= 1) return 0
  return (Math.sqrt(v) - 1) * Math.min(a_, b)
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function drawGrid(ctx: CanvasRenderingContext2D, cam: { x: number; y: number; zoom: number }, w: number, h: number): void {
  let step = 40
  while (step * cam.zoom < 28) step *= 2
  while (step * cam.zoom > 240) step /= 2
  const major = step * 5
  const x0 = Math.floor((cam.x - w / 2 / cam.zoom) / step) * step
  const y0 = Math.floor((cam.y - h / 2 / cam.zoom) / step) * step
  const x1 = cam.x + w / 2 / cam.zoom
  const y1 = cam.y + h / 2 / cam.zoom
  ctx.lineWidth = 1 / cam.zoom
  for (let x = x0; x <= x1; x += step) {
    const isMajor = Math.abs(Math.round(x / major) * major - x) < 0.001
    ctx.strokeStyle = isMajor ? 'rgba(0,0,0,0.09)' : 'rgba(0,0,0,0.045)'
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
    ctx.stroke()
  }
  for (let y = y0; y <= y1; y += step) {
    const isMajor = Math.abs(Math.round(y / major) * major - y) < 0.001
    ctx.strokeStyle = isMajor ? 'rgba(0,0,0,0.09)' : 'rgba(0,0,0,0.045)'
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
  }
  if (cam.x - w / 2 / cam.zoom < 0 && 0 < x1) {
    ctx.strokeStyle = 'rgba(0,0,0,0.14)'
    ctx.beginPath()
    ctx.moveTo(0, y0)
    ctx.lineTo(0, y1)
    ctx.stroke()
  }
  if (cam.y - h / 2 / cam.zoom < 0 && 0 < y1) {
    ctx.strokeStyle = 'rgba(0,0,0,0.14)'
    ctx.beginPath()
    ctx.moveTo(x0, 0)
    ctx.lineTo(x1, 0)
    ctx.stroke()
  }
}

export function itemBounds(item: Stroke | Shape | TextItem): { x0: number; y0: number; x1: number; y1: number } {
  if ('points' in item) {
    if (!item.points.length) return { x0: 0, y0: 0, x1: 0, y1: 0 }
    const xs = item.points.map((p) => p.x)
    const ys = item.points.map((p) => p.y)
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  }
  if ('text' in item) {
    const w = item.text.length * item.size * 0.62
    return { x0: item.x - w / 2, y0: item.y - item.size * 1.3, x1: item.x + w / 2, y1: item.y + item.size * 0.3 }
  }
  return { x0: Math.min(item.x0, item.x1), y0: Math.min(item.y0, item.y1), x1: Math.max(item.x0, item.x1), y1: Math.max(item.y0, item.y1) }
}

export function findItem(doc: Doc, id: string): ItemRef | null {
  for (const s of doc.strokes) if (s.id === id) return { kind: 'stroke', item: s }
  for (const s of doc.shapes) if (s.id === id) return { kind: 'shape', item: s }
  for (const s of doc.texts) if (s.id === id) return { kind: 'text', item: s }
  return null
}

export function hitTest(w: Pt, doc: Doc, zoom: number): ItemRef | null {
  const t = Math.max(5, 8 / zoom)
  const editable = editableLayerSet(doc)
  const candidates: ItemRef[] = []
  for (const s of doc.strokes) if (editable(s.layer)) candidates.push({ kind: 'stroke', item: s })
  for (const s of doc.shapes) if (editable(s.layer)) candidates.push({ kind: 'shape', item: s })
  for (const s of doc.texts) if (!s.attachId && editable(s.layer)) candidates.push({ kind: 'text', item: s })
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i]
    if (c.kind === 'stroke') {
      if (distToPolyline(w, (c.item as Stroke).points) <= Math.max(t, (c.item as Stroke).size / 2)) return c
    } else if (c.kind === 'shape') {
      if (shapeDist(w, c.item as Shape, doc) <= t + (c.item as Shape).size / 2) return c
    } else {
      const ti = c.item as TextItem
      const bw = ti.text.length * ti.size * 0.62
      const bh = ti.size * 1.6
      if (Math.abs(w.x - ti.x) <= bw / 2 + t && Math.abs(w.y - ti.y) <= bh / 2 + t) return c
    }
  }
  return null
}

export function hitShape(w: Pt, doc: Doc, zoom: number): Shape | null {
  const t = Math.max(6, 8 / zoom)
  const editable = editableLayerSet(doc)
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const sh = doc.shapes[i]
    if (!editable(sh.layer)) continue
    if (shapeDist(w, sh, doc) <= t) return sh
  }
  return null
}

export function getSelectionBounds(doc: Doc, selected: string[], zoom: number): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!selected.length) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const id of selected) {
    const ref = findItem(doc, id)
    if (!ref) continue
    const b = itemBounds(ref.item)
    if (b.x0 < x0) x0 = b.x0
    if (b.y0 < y0) y0 = b.y0
    if (b.x1 > x1) x1 = b.x1
    if (b.y1 > y1) y1 = b.y1
  }
  if (!isFinite(x0)) return null
  const pad = 6 / zoom
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

export function hitResizeHandle(w: Pt, bounds: { x0: number; y0: number; x1: number; y1: number }, zoom: number): ResizeHandle | null {
  const handleSize = 8 / zoom
  const hs = handleSize / 2

  const handles: { h: ResizeHandle; x: number; y: number }[] = [
    { h: 'nw', x: bounds.x0, y: bounds.y0 },
    { h: 'ne', x: bounds.x1, y: bounds.y0 },
    { h: 'sw', x: bounds.x0, y: bounds.y1 },
    { h: 'se', x: bounds.x1, y: bounds.y1 },
  ]

  for (const h of handles) {
    if (w.x >= h.x - hs && w.x <= h.x + hs && w.y >= h.y - hs && w.y <= h.y + hs) {
      return h.h
    }
  }
  return null
}

const RESIZE_CURSORS: Record<ResizeHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  w: 'ew-resize',
  e: 'ew-resize',
  sw: 'nesw-resize',
  s: 'ns-resize',
  se: 'nwse-resize',
}

export function getResizeCursor(h: ResizeHandle): string {
  return RESIZE_CURSORS[h]
}
