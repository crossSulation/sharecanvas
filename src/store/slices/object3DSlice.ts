import type { StateCreator } from 'zustand'
import type { CanvasState } from '../types'
import type { Obj3D, ObjKind } from '../../types'
import { createId } from '../../lib/id'
import { yDeleteItems, yObjects, yPush, yUpdateItem } from '../../lib/yroom'

export interface Object3DSlice {
  addObject(kind: ObjKind): void
  updateObject3d(id: string, patch: Partial<Omit<Obj3D, 'id' | 'kind'>>): void
  removeObject3d(id: string): void
  duplicateObject3d(id: string): void
}

export const createObject3DSlice: StateCreator<CanvasState, [], [], Object3DSlice> = (
  set,
  get,
) => ({
  addObject: (kind) => {
    const z = kind === 'plane' ? 0.04 : 0.6
    yPush('objects', [
      {
        id: createId('o'),
        kind,
        pos: [Math.random() * 4 - 2, z, Math.random() * 4 - 2],
        rot: [0, 0, 0],
        scale: [1, 1, 1],
        color: get().color,
      },
    ])
  },
  updateObject3d: (id, patch) => yUpdateItem('objects', id, patch),
  removeObject3d: (id) => yDeleteItems('objects', [id]),
  duplicateObject3d: (id) => {
    const o = yObjects
      .toArray()
      .map((m) => m.toJSON() as unknown as Obj3D)
      .find((x) => x.id === id)
    if (!o) return
    yPush('objects', [
      {
        ...structuredClone(o),
        id: createId('o'),
        pos: [o.pos[0] + 0.6, o.pos[1], o.pos[2] + 0.6],
      },
    ])
  },
})
