import type { StateCreator } from 'zustand'
import type { CanvasState } from '../types'
import type { Camera2D, Tool, StrokeKind } from '../../types'
import {
  DEFAULT_LAYER_ID,
  yReplace,
  yClearAll,
  yPush,
  importDocIntoY,
} from '../../lib/yroom'

export interface CanvasSlice {
  camera: Camera2D
  tool: Tool
  color: string
  size: number
  eraserSize: number
  brushStyle: StrokeKind
  boxSelecting: boolean
  setCamera(p: Partial<Camera2D>): void
  setTool(t: Tool): void
  setColor(c: string): void
  setSize(s: number): void
  setEraserSize(s: number): void
  setBrushStyle(k: StrokeKind): void
  setBoxSelecting(v: boolean): void
  clearScreen(): void
  clearAll(): void
  importDoc(doc: Parameters<typeof importDocIntoY>[0]): void
}

export const createCanvasSlice: StateCreator<CanvasState, [], [], CanvasSlice> = (set, get) => ({
  camera: { x: 0, y: 0, zoom: 1 },
  tool: 'pen' as Tool,
  color: '#18181b',
  size: 4,
  eraserSize: 24,
  brushStyle: 'pen' as StrokeKind,
  boxSelecting: false,

  setCamera: (p) => set((s) => ({ camera: { ...s.camera, ...p } })),
  setTool: (t) => set({ tool: t, boxSelecting: false }),
  setColor: (c) => set({ color: c }),
  setSize: (s) => set({ size: s }),
  setEraserSize: (s) => set({ eraserSize: s }),
  setBrushStyle: (k) => set({ brushStyle: k, tool: 'pen' }),
  setBoxSelecting: (v) => set({ boxSelecting: v }),

  clearScreen: () => {
    const s = get()
    const { camera, viewport } = s
    if (viewport.w < 1 || viewport.h < 1) return
    const zoom = camera.zoom
    const x0 = camera.x - viewport.w / 2 / zoom
    const x1 = camera.x + viewport.w / 2 / zoom
    const y0 = camera.y - viewport.h / 2 / zoom
    const y1 = camera.y + viewport.h / 2 / zoom
    const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1
    const d = s.doc
    const editable = new Set(
      d.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    )
    const eff = (l?: string) =>
      l && d.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID
    const isEditable = (l?: string) => editable.has(eff(l))
    const removedShapes = new Set<string>()
    const keepShapes = d.shapes.filter((sh) => {
      const a0 = Math.min(sh.x0, sh.x1)
      const a1 = Math.max(sh.x0, sh.x1)
      const b0 = Math.min(sh.y0, sh.y1)
      const b1 = Math.max(sh.y0, sh.y1)
      const inViewShape = a1 >= x0 && a0 <= x1 && b1 >= y0 && b0 <= y1
      const keep = !(inViewShape && isEditable(sh.layer))
      if (!keep) removedShapes.add(sh.id)
      return keep
    })
    yReplace(
      'strokes',
      d.strokes.filter(
        (st) => !(isEditable(st.layer) && st.points.some((p) => inView(p.x, p.y))),
      ),
    )
    yReplace('shapes', keepShapes)
    yReplace(
      'texts',
      d.texts.filter(
        (t) =>
          t.attachId
            ? !removedShapes.has(t.attachId)
            : !(isEditable(t.layer) && inView(t.x, t.y)),
      ),
    )
  },
  clearAll: () => {
    yClearAll()
    yPush('layers', [
      { id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 },
    ])
    set({ selected: [], selected3d: null, activeLayerId: DEFAULT_LAYER_ID })
  },
  importDoc: (doc) => {
    importDocIntoY(doc)
    set({ selected: [], selected3d: null })
  },
})
