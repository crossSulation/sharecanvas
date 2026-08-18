import { drawLayerContent, drawLayerContentGL, type WorldRect } from './layerRender'
import { WebGLRenderer } from './webglRender'
import { GlyphAtlas } from './glyphAtlas'
import type { Doc } from '../types'

interface RasterMessage {
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

const workerSelf = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(msg: unknown, transfer?: Transferable[]): void
}

if (typeof OffscreenCanvas === 'undefined') {
  workerSelf.postMessage({ type: 'unsupported' })
} else {
  workerSelf.onmessage = (e: MessageEvent) => {
    const msg = e.data as RasterMessage
    if (!msg || msg.type !== 'raster') return
    const halfW = msg.viewport.w / 2 / msg.zoom
    const halfH = msg.viewport.h / 2 / msg.zoom
    const cw = Math.max(1, Math.ceil(halfW * msg.margin * 2 * msg.zoom * msg.dpr))
    const ch = Math.max(1, Math.ceil(halfH * msg.margin * 2 * msg.zoom * msg.dpr))
    const left = msg.camera.x - halfW * msg.margin
    const top = msg.camera.y - halfH * msg.margin
    const view: WorldRect = {
      x0: left,
      y0: top,
      x1: left + halfW * msg.margin * 2,
      y1: top + halfH * msg.margin * 2,
    }
    const layerOf = (l?: string) =>
      l && msg.doc.layers.some((x) => x.id === l) ? l : msg.defaultLayerId

    try {
      const off = new OffscreenCanvas(cw, ch)
      // 优先 WebGL（硬件加速，含文字字形图集）；不支持时回退 2D 光栅化
      let gl: WebGLRenderingContext | null = null
      // 用独立小画布探测 WebGL，避免探测失败后锁定正式画布的上下文类型
      const probe = new OffscreenCanvas(1, 1)
      const supported = !!(probe.getContext('webgl2') || probe.getContext('webgl'))
      if (supported) {
        const opts: WebGLContextAttributes = { antialias: true, alpha: true, premultipliedAlpha: true }
        gl = (off.getContext('webgl2', opts) || off.getContext('webgl', opts)) as WebGLRenderingContext | null
      }

      if (gl) {
        const renderer = new WebGLRenderer(gl)
        const atlas = new GlyphAtlas(gl)
        renderer.begin(view)
        drawLayerContentGL(renderer, atlas, msg.doc, msg.layerId, msg.layerOpacity, layerOf, view, msg.zoom * msg.dpr)
      } else {
        const ctx = off.getContext('2d')
        if (!ctx) {
          workerSelf.postMessage({ type: 'error', layerId: msg.layerId, message: 'no 2d context' })
          return
        }
        ctx.setTransform(msg.zoom * msg.dpr, 0, 0, msg.zoom * msg.dpr, 0, 0)
        ctx.translate(-left, -top)
        ctx.clearRect(left, top, halfW * msg.margin * 2, halfH * msg.margin * 2)
        drawLayerContent(ctx, msg.doc, msg.layerId, msg.layerOpacity, layerOf, view)
      }

      const bitmap = off.transferToImageBitmap()
      const aa = gl ? gl.getContextAttributes()?.antialias : undefined
      workerSelf.postMessage(
        {
          type: 'rasterized',
          layerId: msg.layerId,
          path: gl ? (aa ? 'webgl' : 'webgl-noaa') : '2d',
          bitmap,
          width: cw,
          height: ch,
          zoom: msg.zoom,
          camX: msg.camera.x,
          camY: msg.camera.y,
        },
        [bitmap],
      )
    } catch (err) {
      workerSelf.postMessage({
        type: 'error',
        layerId: msg.layerId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
