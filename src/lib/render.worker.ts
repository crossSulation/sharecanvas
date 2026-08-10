import { drawLayerContent, type WorldRect } from './layerRender'
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
    try {
      const off = new OffscreenCanvas(cw, ch)
      const ctx = off.getContext('2d')
      if (!ctx) {
        workerSelf.postMessage({ type: 'error', layerId: msg.layerId, message: 'no 2d context' })
        return
      }
      const left = msg.camera.x - halfW * msg.margin
      const top = msg.camera.y - halfH * msg.margin
      const view: WorldRect = {
        x0: left,
        y0: top,
        x1: left + halfW * msg.margin * 2,
        y1: top + halfH * msg.margin * 2,
      }
      ctx.setTransform(msg.zoom * msg.dpr, 0, 0, msg.zoom * msg.dpr, 0, 0)
      ctx.translate(-left, -top)
      ctx.clearRect(left, top, halfW * msg.margin * 2, halfH * msg.margin * 2)
      const layerOf = (l?: string) =>
        l && msg.doc.layers.some((x) => x.id === l) ? l : msg.defaultLayerId
      drawLayerContent(ctx, msg.doc, msg.layerId, msg.layerOpacity, layerOf, view)
      const bitmap = off.transferToImageBitmap()
      workerSelf.postMessage(
        {
          type: 'rasterized',
          layerId: msg.layerId,
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
