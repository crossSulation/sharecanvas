import {
  brushPreset,
  drawLayerContent,
  angleGeometry,
  axesGeometry,
  polygonPoints,
  parabolaPoints,
  shapeBounds,
  shapeEndpoints,
  strokeBounds,
  strokeOutlinePoints,
  textBounds,
  type WorldRect,
} from './layerRender'
import { DEFAULT_LAYER_ID } from './yroom'
import type { Doc, LayerInfo, Shape, Stroke, TextItem } from '../types'

const EXPORT_PAD = 40
const MAX_DIM = 4096

function layerOf(doc: Doc, l?: string): string {
  return l && doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID
}

function layersOf(doc: Doc): LayerInfo[] {
  return doc.layers.length
    ? doc.layers
    : [{ id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 }]
}

/** 文档内容的世界坐标包围盒（含内边距），用于导出取景 */
export function docContentBounds(doc: Doc): WorldRect {
  const visible = (l?: string) => {
    const info = doc.layers.find((x) => x.id === layerOf(doc, l))
    return doc.layers.length === 0 || (info?.visible ?? true)
  }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const acc = (b: WorldRect) => {
    if (b.x0 < x0) x0 = b.x0
    if (b.y0 < y0) y0 = b.y0
    if (b.x1 > x1) x1 = b.x1
    if (b.y1 > y1) y1 = b.y1
  }
  for (const s of doc.strokes) if (visible(s.layer)) acc(strokeBounds(s))
  for (const sh of doc.shapes) if (visible(sh.layer)) acc(shapeBounds(sh))
  for (const t of doc.texts) if (visible(t.layer)) acc(textBounds(t))
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 1000, y1: 800 }
  return { x0: x0 - EXPORT_PAD, y0: y0 - EXPORT_PAD, x1: x1 + EXPORT_PAD, y1: y1 + EXPORT_PAD }
}

function fitScale(bounds: WorldRect): number {
  const w = bounds.x1 - bounds.x0
  const h = bounds.y1 - bounds.y0
  return Math.min(MAX_DIM / Math.max(w, h), 8)
}

/** 按图层顺序（layers[0] 为顶层）把整份文档渲染到画布，返回像素画布 */
export function renderDocToCanvas(doc: Doc, bounds: WorldRect, scale: number): HTMLCanvasElement {
  const w = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) * scale))
  const h = Math.max(1, Math.ceil((bounds.y1 - bounds.y0) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  const lof = (l?: string) => layerOf(doc, l)
  const layers = layersOf(doc)
  // 与主画布一致：layers[0] 在顶部，先画底层再画顶层
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (!layer.visible) continue
    const tmp = document.createElement('canvas')
    tmp.width = w
    tmp.height = h
    const tctx = tmp.getContext('2d')
    if (!tctx) continue
    tctx.setTransform(scale, 0, 0, scale, 0, 0)
    tctx.translate(-bounds.x0, -bounds.y0)
    drawLayerContent(tctx, doc, layer.id, layer.opacity, lof, bounds)
    ctx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation
    ctx.drawImage(tmp, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }
  return canvas
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportName(ext: string): string {
  return `sharecanvas-${new Date().toISOString().slice(0, 10)}.${ext}`
}

export function exportDocPNG(doc: Doc): void {
  const bounds = docContentBounds(doc)
  const canvas = renderDocToCanvas(doc, bounds, fitScale(bounds))
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, exportName('png'))
  }, 'image/png')
}

export function exportDocPDF(doc: Doc): Promise<void> {
  return import('jspdf').then(({ jsPDF }) => {
    const bounds = docContentBounds(doc)
    const scale = fitScale(bounds)
    const canvas = renderDocToCanvas(doc, bounds, scale)
    const dataUrl = canvas.toDataURL('image/png')
    const pdf = new jsPDF({
      orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [canvas.width, canvas.height],
      hotfixes: ['px_scaling'],
    })
    pdf.addImage(dataUrl, 'PNG', 0, 0, canvas.width, canvas.height)
    pdf.save(exportName('pdf'))
  })
}

// ---------- SVG ----------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function strokeSvg(s: Stroke): string {
  const preset = brushPreset(s.kind)
  const opacity = preset.opacity ?? s.opacity
  if (s.points.length === 1) {
    const p = s.points[0]
    return `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(Math.max(0.5, s.size / 2))}" fill="${esc(s.color)}" opacity="${fmt(opacity)}"/>`
  }
  const outline = strokeOutlinePoints(s)
  if (outline.length < 3) return ''
  const d = `M ${outline.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L ')} Z`
  return `<path d="${d}" fill="${esc(s.color)}" opacity="${fmt(opacity)}"/>`
}

function shapeSvg(sh: Shape, doc: Doc): string {
  const color = esc(sh.color)
  const width = fmt(Math.max(1, sh.size))
  const stroke = `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`
  switch (sh.kind) {
    case 'rect':
    case 'roundrect': {
      const x = Math.min(sh.x0, sh.x1)
      const y = Math.min(sh.y0, sh.y1)
      const w = Math.abs(sh.x1 - sh.x0)
      const h = Math.abs(sh.y1 - sh.y0)
      const rx = sh.kind === 'roundrect' ? Math.min(w, h) * 0.25 : 0
      return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(rx)}" ${stroke}/>`
    }
    case 'ellipse': {
      const cx = (sh.x0 + sh.x1) / 2
      const cy = (sh.y0 + sh.y1) / 2
      return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(Math.abs(sh.x1 - sh.x0) / 2)}" ry="${fmt(Math.abs(sh.y1 - sh.y0) / 2)}" ${stroke}/>`
    }
    case 'line': {
      const { start, end } = shapeEndpoints(sh, doc)
      return `<line x1="${fmt(start.x)}" y1="${fmt(start.y)}" x2="${fmt(end.x)}" y2="${fmt(end.y)}" ${stroke}/>`
    }
    case 'arrow': {
      const { start, end } = shapeEndpoints(sh, doc)
      const angle = Math.atan2(end.y - start.y, end.x - start.x)
      const len = 12 + sh.size * 1.5
      const p1 = { x: end.x - len * Math.cos(angle - Math.PI / 7), y: end.y - len * Math.sin(angle - Math.PI / 7) }
      const p2 = { x: end.x - len * Math.cos(angle + Math.PI / 7), y: end.y - len * Math.sin(angle + Math.PI / 7) }
      return (
        `<line x1="${fmt(start.x)}" y1="${fmt(start.y)}" x2="${fmt(end.x)}" y2="${fmt(end.y)}" ${stroke}/>` +
        `<polygon points="${fmt(end.x)},${fmt(end.y)} ${fmt(p1.x)},${fmt(p1.y)} ${fmt(p2.x)},${fmt(p2.y)}" fill="${color}" stroke="none"/>`
      )
    }
    case 'angle': {
      const g = angleGeometry(sh)
      const arcD = g.arc.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ')
      return (
        `<path d="M${fmt(g.v.x)} ${fmt(g.v.y)}L${fmt(g.ray1.x)} ${fmt(g.ray1.y)}M${fmt(g.v.x)} ${fmt(g.v.y)}L${fmt(g.ray2.x)} ${fmt(g.ray2.y)}${arcD}" ${stroke}/>`
      )
    }
    case 'axes': {
      const g = axesGeometry(sh)
      const len = 10 + sh.size * 1.2
      const right = `${fmt(g.x1)},${fmt(g.cy)} ${fmt(g.x1 - len)},${fmt(g.cy - len * 0.45)} ${fmt(g.x1 - len)},${fmt(g.cy + len * 0.45)}`
      const up = `${fmt(g.cx)},${fmt(g.y0)} ${fmt(g.cx - len * 0.45)},${fmt(g.y0 + len)} ${fmt(g.cx + len * 0.45)},${fmt(g.y0 + len)}`
      return (
        `<line x1="${fmt(g.x0)}" y1="${fmt(g.cy)}" x2="${fmt(g.x1)}" y2="${fmt(g.cy)}" ${stroke}/>` +
        `<line x1="${fmt(g.cx)}" y1="${fmt(g.y1)}" x2="${fmt(g.cx)}" y2="${fmt(g.y0)}" ${stroke}/>` +
        `<polygon points="${right}" fill="${color}" stroke="none"/>` +
        `<polygon points="${up}" fill="${color}" stroke="none"/>`
      )
    }
    case 'parabola': {
      const pts = parabolaPoints(sh)
      return `<polyline points="${pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" ${stroke}/>`
    }
    default: {
      const pts = polygonPoints(sh)
      if (!pts.length) return ''
      return `<polygon points="${pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" ${stroke}/>`
    }
  }
}

function textSvg(t: TextItem): string {
  const anchor = t.attachId ? ` text-anchor="middle" dominant-baseline="central"` : ''
  return (
    `<text x="${fmt(t.x)}" y="${fmt(t.y)}" font-size="${fmt(t.size)}" fill="${esc(t.color)}"` +
    ` font-family="ui-sans-serif, system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif"${anchor}>${esc(t.text)}</text>`
  )
}

/** 生成完整 SVG 字符串（纯函数，便于测试与复用） */
export function buildSvgString(doc: Doc): string {
  const bounds = docContentBounds(doc)
  const w = bounds.x1 - bounds.x0
  const h = bounds.y1 - bounds.y0
  const lof = (l?: string) => layerOf(doc, l)
  const masks: string[] = []
  const groups: string[] = []
  const layers = layersOf(doc)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    if (!layer.visible) continue
    const body: string[] = []
    for (const s of doc.strokes) if (lof(s.layer) === layer.id) body.push(strokeSvg(s))
    for (const sh of doc.shapes) if (lof(sh.layer) === layer.id) body.push(shapeSvg(sh, doc))
    for (const t of doc.texts) if (lof(t.layer) === layer.id) body.push(textSvg(t))
    if (!body.length) continue
    const erasers = doc.eraser.filter((c) => lof(c.layer) === layer.id)
    const maskId = `eraser-${layer.id}`
    groups.push(`<g opacity="${fmt(layer.opacity)}"${erasers.length ? ` mask="url(#${maskId})"` : ''}>${body.join('')}</g>`)
    if (erasers.length) {
      masks.push(
        `<mask id="${maskId}">` +
          `<rect x="${fmt(bounds.x0)}" y="${fmt(bounds.y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="#fff"/>` +
          erasers.map((c) => `<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(c.r)}" fill="#000"/>`).join('') +
          '</mask>',
      )
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}" height="${fmt(h)}" viewBox="${fmt(bounds.x0)} ${fmt(bounds.y0)} ${fmt(w)} ${fmt(h)}">` +
    `<rect x="${fmt(bounds.x0)}" y="${fmt(bounds.y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="#ffffff"/>` +
    (masks.length ? `<defs>${masks.join('')}</defs>` : '') +
    groups.join('') +
    '</svg>'
  )
}

export function exportDocSVG(doc: Doc): void {
  downloadBlob(new Blob([buildSvgString(doc)], { type: 'image/svg+xml' }), exportName('svg'))
}
