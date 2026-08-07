import type { StateCreator } from 'zustand'
import type { CanvasState } from '../types'
import {
  DEFAULT_LAYER_ID,
  transactLocal,
  yDeleteItems,
  yInsertAt,
  yLayers,
  yUpdateItem,
} from '../../lib/yroom'
import { createId } from '../../lib/id'

export interface LayerSlice {
  activeLayerId: string
  layerPanelOpen: boolean
  setActiveLayer(id: string): void
  setLayerPanelOpen(v: boolean): void
  addLayer(): void
  removeLayer(id: string): void
  renameLayer(id: string, name: string): void
  moveLayer(id: string, dir: -1 | 1): void
  setLayerVisible(id: string, v: boolean): void
  setLayerLocked(id: string, v: boolean): void
  setLayerOpacity(id: string, v: number): void
}

export const createLayerSlice: StateCreator<CanvasState, [], [], LayerSlice> = (set, get) => ({
  activeLayerId: '',
  layerPanelOpen: false,

  setActiveLayer: (id) => set({ activeLayerId: id }),
  setLayerPanelOpen: (v) => set({ layerPanelOpen: v }),

  addLayer: () => {
    const count = get().doc.layers.length + 1
    const id = createId('layer')
    yInsertAt('layers', 0, [
      { id, name: `图层 ${count}`, visible: true, locked: false, opacity: 1 },
    ])
    set({ activeLayerId: id })
  },
  removeLayer: (id) => {
    const s = get()
    if (s.doc.layers.length <= 1) return
    const d = s.doc
    const eff = (l?: string) =>
      l && d.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID
    yDeleteItems(
      'strokes',
      d.strokes.filter((x) => eff(x.layer) === id).map((x) => x.id),
    )
    yDeleteItems(
      'shapes',
      d.shapes.filter((x) => eff(x.layer) === id).map((x) => x.id),
    )
    yDeleteItems(
      'texts',
      d.texts.filter((x) => eff(x.layer) === id).map((x) => x.id),
    )
    yDeleteItems(
      'eraser',
      d.eraser.filter((x) => eff(x.layer) === id).map((x) => x.id),
    )
    yDeleteItems('layers', [id])
    const next = get().doc.layers[0]?.id ?? DEFAULT_LAYER_ID
    set({ activeLayerId: next })
  },
  renameLayer: (id, name) => yUpdateItem('layers', id, { name }),
  moveLayer: (id, dir) => {
    transactLocal(() => {
      const arr = yLayers
      const idx = arr.toArray().findIndex((m) => m.get('id') === id)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= arr.length) return
      const a = arr.get(idx)
      const b = arr.get(target)
      arr.delete(target, 1)
      arr.delete(idx, 1)
      arr.insert(Math.min(idx, target), [a, b])
    })
  },
  setLayerVisible: (id, v) => yUpdateItem('layers', id, { visible: v }),
  setLayerLocked: (id, v) => yUpdateItem('layers', id, { locked: v }),
  setLayerOpacity: (id, v) => yUpdateItem('layers', id, { opacity: v }),
})
