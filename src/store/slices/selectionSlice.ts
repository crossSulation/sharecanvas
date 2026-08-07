import type { StateCreator } from 'zustand'
import type { CanvasState } from '../types'
import { yDeleteItems, undoManager } from '../../lib/yroom'

export interface SelectionSlice {
  selected: string[]
  selected3d: string | null
  canUndo: boolean
  canRedo: boolean
  select(ids: string[]): void
  select3d(id: string | null): void
  undo(): void
  redo(): void
  deleteSelected(): void
}

export const createSelectionSlice: StateCreator<CanvasState, [], [], SelectionSlice> = (
  set,
  get,
) => ({
  selected: [],
  selected3d: null,
  canUndo: false,
  canRedo: false,

  select: (ids) => set({ selected: ids }),
  select3d: (id) => set({ selected3d: id }),

  undo: () => undoManager.undo(),
  redo: () => undoManager.redo(),

  deleteSelected: () => {
    const s = get()
    const ids = s.selected
    if (!ids.length) return
    const shapeIds = s.doc.shapes.filter((x) => ids.includes(x.id)).map((x) => x.id)
    const textIds = s.doc.texts
      .filter((x) => ids.includes(x.id) || (x.attachId && shapeIds.includes(x.attachId)))
      .map((x) => x.id)
    yDeleteItems('strokes', ids)
    yDeleteItems('shapes', ids)
    yDeleteItems('texts', textIds)
    set({ selected: [] })
  },
})
