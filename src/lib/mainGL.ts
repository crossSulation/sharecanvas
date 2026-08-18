// 主画布 WebGL 渲染：拥有可见画布的 GL 上下文、矢量渲染器、字形图集，
// 以及图层位图纹理缓存与离屏 FBO（同步光栅化用）。配套网格/手势/选区/光标绘制。
//
// 约定：V=0 = 图片/世界顶部（与 glyphAtlas / 上传位图 / FBO 离屏光栅化一致）。

import { WebGLRenderer, parseColor, type RGBA } from './webglRender'
import { GlyphAtlas, measureTextWidth } from './glyphAtlas'
import {
  drawLayerContentGL,
  drawStrokeGL,
  drawShapeGL,
  drawStrokeLiveGL,
  drawTextString,
  roundRectPoints,
  type WorldRect,
} from './layerRender'
import { DEFAULT_LAYER_ID } from './yroom'
import { eraserRadius, getSelectionBounds, findItem, type Interaction } from '../components/canvasHelpers'
import { axesParams } from './layerRender'
import type { Doc, Pt, RemoteUser, Shape, Stroke, TextItem } from '../types'

interface LayerTex {
  tex: WebGLTexture
  w: number
  h: number
}

const BLACK = (a: number): RGBA => [0, 0, 0, a]

export class MainGL {
  readonly gl: WebGLRenderingContext
  readonly renderer: WebGLRenderer
  readonly atlas: GlyphAtlas
  private textures = new Map<string, LayerTex>()
  private fbo: WebGLFramebuffer | null = null
  private visibleView: WorldRect = { x0: 0, y0: 0, x1: 1, y1: 1 }
  private visibleVp = { w: 1, h: 1 }

  constructor(canvas: HTMLCanvasElement) {
    const opts: WebGLContextAttributes = { antialias: true, alpha: true, premultipliedAlpha: true }
    const gl = (canvas.getContext('webgl2', opts) ||
      canvas.getContext('webgl', opts)) as WebGLRenderingContext | null
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl
    this.renderer = new WebGLRenderer(gl)
    this.atlas = new GlyphAtlas(gl)
    this.fbo = gl.createFramebuffer()
  }

  beginFrame(view: WorldRect): void {
    this.visibleView = view
    this.visibleVp = { w: this.gl.drawingBufferWidth, h: this.gl.drawingBufferHeight }
    this.renderer.begin(view)
  }

  textureFor(layerId: string): LayerTex | undefined {
    return this.textures.get(layerId)
  }

  // 上传 worker 返回的图层位图到纹理（尺寸变化时重建）
  uploadBitmap(layerId: string, bitmap: ImageBitmap, w: number, h: number): void {
    const gl = this.gl
    const prev = this.textures.get(layerId)
    let tex = prev?.tex ?? null
    if (!tex || prev!.w !== w || prev!.h !== h) {
      if (tex) gl.deleteTexture(tex)
      tex = this.allocTexture(w, h)
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    this.textures.set(layerId, { tex, w, h })
  }

  // 同步光栅化某层到纹理（橡皮擦逐帧 / 提交手势用，避免等待 worker 造成闪烁）
  syncRasterize(
    doc: Doc,
    layerId: string,
    layerOpacity: number,
    cam: { x: number; y: number },
    zoom: number,
    w: number,
    h: number,
    dpr: number,
    margin: number,
  ): { width: number; height: number } {
    const gl = this.gl
    const layerOf = (l?: string) => (l && doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID)
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
    const prev = this.textures.get(layerId)
    let tex = prev?.tex ?? null
    if (!tex || prev!.w !== cw || prev!.h !== ch) {
      if (tex) gl.deleteTexture(tex)
      tex = this.allocTexture(cw, ch)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    // flipY=false：让世界顶部落到纹理 V=0，与上传位图约定一致
    this.renderer.begin(view, { viewportW: cw, viewportH: ch, flipY: false })
    drawLayerContentGL(this.renderer, this.atlas, doc, layerId, layerOpacity, layerOf, view, zoom * dpr)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.textures.set(layerId, { tex, w: cw, h: ch })
    // 恢复可见画布的矩阵与视口（不清屏，避免擦掉已合成的网格/图层）
    this.renderer.setView(this.visibleView, { viewportW: this.visibleVp.w, viewportH: this.visibleVp.h, flipY: true })
    return { width: cw, height: ch }
  }

  remove(layerId: string): void {
    const e = this.textures.get(layerId)
    if (e) {
      this.gl.deleteTexture(e.tex)
      this.textures.delete(layerId)
    }
  }

  // 读回绘制缓冲（自顶向下 RGBA），调试/e2e 像素校验用
  readPixels(): { width: number; height: number; data: Uint8ClampedArray } {
    const gl = this.gl
    const w = gl.drawingBufferWidth
    const h = gl.drawingBufferHeight
    const pixels = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      out.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    }
    return { width: w, height: h, data: out }
  }

  dispose(): void {
    for (const e of this.textures.values()) this.gl.deleteTexture(e.tex)
    this.textures.clear()
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo)
    this.fbo = null
  }

  private allocTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    return tex
  }
}

function circlePoints(c: Pt, r: number, n = 32): Pt[] {
  const pts: Pt[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts[i] = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }
  }
  return pts
}

function ring(r: WebGLRenderer, c: Pt, radius: number, width: number, color: RGBA, alpha: number): void {
  r.strokePolyline(circlePoints(c, radius), width, color, alpha, true)
}

// 网格（世界坐标，宽度 1/zoom 对齐 2D 版本）
export function drawGridGL(r: WebGLRenderer, cam: { x: number; y: number; zoom: number }, w: number, h: number): void {
  let step = 40
  while (step * cam.zoom < 28) step *= 2
  while (step * cam.zoom > 240) step /= 2
  const major = step * 5
  const x0 = Math.floor((cam.x - w / 2 / cam.zoom) / step) * step
  const y0 = Math.floor((cam.y - h / 2 / cam.zoom) / step) * step
  const x1 = cam.x + w / 2 / cam.zoom
  const y1 = cam.y + h / 2 / cam.zoom
  const lw = 1 / cam.zoom
  for (let x = x0; x <= x1; x += step) {
    const isMajor = Math.abs(Math.round(x / major) * major - x) < 0.001
    r.drawLine({ x, y: y0 }, { x, y: y1 }, lw, BLACK(isMajor ? 0.09 : 0.045), 1)
  }
  for (let y = y0; y <= y1; y += step) {
    const isMajor = Math.abs(Math.round(y / major) * major - y) < 0.001
    r.drawLine({ x: x0, y }, { x: x1, y }, lw, BLACK(isMajor ? 0.09 : 0.045), 1)
  }
  if (cam.x - w / 2 / cam.zoom < 0 && 0 < x1) r.drawLine({ x: 0, y: y0 }, { x: 0, y: y1 }, lw, BLACK(0.14), 1)
  if (cam.y - h / 2 / cam.zoom < 0 && 0 < y1) r.drawLine({ x: x0, y: 0 }, { x: x1, y: 0 }, lw, BLACK(0.14), 1)
}

// 手势覆盖层（绘制中/移动中的内容），镜像 2D 版 drawGestureOverlay
export function drawGestureOverlayGL(
  r: WebGLRenderer,
  atlas: GlyphAtlas,
  doc: Doc,
  it: Interaction | null,
  pixelScale: number,
): void {
  if (!it) return
  if (it.type === 'stroke') {
    drawStrokeLiveGL(r, it.stroke, 1)
  } else if (it.type === 'shape') {
    const sh = doc.shapes.find((x) => x.id === it.id)
    if (sh) drawShapeGL(r, sh, doc, 1)
  } else if (it.type === 'move') {
    const dx = it.dx
    const dy = it.dy
    for (const ref of it.items) {
      if (ref.kind === 'stroke') {
        const s = ref.item as Stroke
        drawStrokeGL(r, { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }, 1)
      } else if (ref.kind === 'shape') {
        const sh = ref.item as Shape
        const preview: Shape = { ...sh, x0: sh.x0 + dx, y0: sh.y0 + dy, x1: sh.x1 + dx, y1: sh.y1 + dy }
        if (sh.kind === 'axes' && sh.params) {
          preview.params = sh.params.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
        }
        drawShapeGL(r, preview, doc, 1)
      } else {
        const t = ref.item as TextItem
        drawTextString(r, atlas, t.text, t.x + dx, t.y + dy, t.size, t.color, 1, pixelScale)
      }
    }
  }
}

// 选区框 + 手柄 + 框选/套索（世界坐标）
export function drawSelectionGL(
  r: WebGLRenderer,
  doc: Doc,
  selected: string[],
  it: Interaction | null,
  zoom: number,
): void {
  if (selected.length) {
    const selBounds = getSelectionBounds(doc, selected, zoom)
    if (selBounds) {
      const dash = 6 / zoom
      const gap = 5 / zoom
      r.drawDashedRect(selBounds.x0, selBounds.y0, selBounds.x1, selBounds.y1, dash, gap, 1.5 / zoom, parseColor('#52525b'), 1)

      const handleSize = 8 / zoom
      const hs = handleSize / 2
      const single = selected.length === 1 ? findItem(doc, selected[0]) : null
      const axesSh = single?.kind === 'shape' && (single.item as Shape).kind === 'axes' ? (single.item as Shape) : null
      const handlePts = axesSh
        ? (() => {
            const p = axesParams(axesSh)
            return [
              { x: p.px0, y: p.oy },
              { x: p.px1, y: p.oy },
              { x: p.ox, y: p.py0 },
              { x: p.ox, y: p.py1 },
              { x: p.ox, y: p.oy },
            ]
          })()
        : [
            { x: selBounds.x0, y: selBounds.y0 },
            { x: selBounds.x1, y: selBounds.y0 },
            { x: selBounds.x0, y: selBounds.y1 },
            { x: selBounds.x1, y: selBounds.y1 },
          ]
      for (const hp of handlePts) {
        r.fillRect(hp.x - hs, hp.y - hs, hp.x + hs, hp.y + hs, [1, 1, 1, 1], 1)
        r.strokeRectOutline(hp.x - hs, hp.y - hs, hp.x + hs, hp.y + hs, 1.5 / zoom, parseColor('#52525b'), 1)
      }
    }
  }
  if (it?.type === 'boxselect') {
    const x0 = Math.min(it.start.x, it.end.x)
    const y0 = Math.min(it.start.y, it.end.y)
    const x1 = Math.max(it.start.x, it.end.x)
    const y1 = Math.max(it.start.y, it.end.y)
    r.fillRect(x0, y0, x1, y1, parseColor('#3b82f6'), 0.08)
    r.drawDashedRect(x0, y0, x1, y1, 4 / zoom, 3 / zoom, 2 / zoom, parseColor('#3b82f6'), 1)
  }
  if (it?.type === 'lasso' && it.pts.length >= 2) {
    r.drawDashedPolyline(it.pts, 4 / zoom, 3 / zoom, 2 / zoom, parseColor('#3b82f6'), 1)
  }
}

// 橡皮擦光标（世界坐标，尺寸恒定对齐 2D 屏幕空间）
export function drawEraserCursorGL(r: WebGLRenderer, at: Pt, size: number, zoom: number): void {
  const radius = eraserRadius(size)
  r.fillCircle(at, radius, BLACK(0.04), 1)
  ring(r, at, radius, 1.2 / zoom, BLACK(0.45), 1)
}

// 远端用户光标 + 名字徽标（世界坐标）
export function drawRemoteCursorsGL(
  r: WebGLRenderer,
  atlas: GlyphAtlas,
  users: Record<string, RemoteUser>,
  selfId: string,
  positions: Map<string, Pt>,
  zoom: number,
  pixelScale: number,
): void {
  for (const u of Object.values(users)) {
    if (u.id === selfId || !u.cursor) continue
    const disp = positions.get(u.id) ?? u.cursor
    const cr = 5 / zoom
    const color = parseColor(u.color)
    r.fillCircle(disp, cr, color, 1)
    ring(r, disp, cr, 1 / zoom, BLACK(0.6), 1)
    const fs = 11 / zoom
    const tw = measureTextWidth(u.name, fs)
    const bw = tw + 10 / zoom
    const bh = 17 / zoom
    const bx = disp.x - bw / 2
    const by = disp.y - 26 / zoom
    r.fillPolygon(roundRectPoints(bx, by, bx + bw, by + bh, 4 / zoom), BLACK(0.65), 1)
    drawTextString(r, atlas, u.name, disp.x, disp.y - 14 / zoom, fs, '#ffffff', 1, pixelScale, { align: 'center' })
  }
}
