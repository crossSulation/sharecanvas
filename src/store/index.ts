import { create } from 'zustand'
import { createAppSlice } from './slices/appSlice'
import { createCanvasSlice } from './slices/canvasSlice'
import { createLayerSlice } from './slices/layerSlice'
import { createObject3DSlice } from './slices/object3DSlice'
import { createSelectionSlice } from './slices/selectionSlice'
import type { CanvasState } from './types'
import { yToDoc, undoManager, yDoc } from '../lib/yroom'
import { collab } from '../lib/collab'
import { loadPrefs } from '../lib/storage'

export const PALETTE = [
  '#18181b',
  '#ffffff',
  '#e5e7eb',
  '#52525b',
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#4ade80',
  '#38bdf8',
  '#3b82f6',
  '#ec4899',
  '#a16207',
]

const prefs = loadPrefs()
const initialDoc = yToDoc()

export const useStore = create<CanvasState>()((...a) => ({
  ...createAppSlice(...a),
  ...createCanvasSlice(...a),
  ...createLayerSlice(...a),
  ...createObject3DSlice(...a),
  ...createSelectionSlice(...a),
  doc: initialDoc,
  color: prefs.color || '#18181b',
  activeLayerId: initialDoc.layers.find((l) => l.id)?.id ?? '',
}))

// ---------- Yjs 变更 -> 镜像文档 + 防抖持久化 ----------

function refreshUndoFlags(): void {
  useStore.setState({
    canUndo: undoManager.canUndo(),
    canRedo: undoManager.canRedo(),
  })
}

undoManager.on('stack-item-added', refreshUndoFlags)
undoManager.on('stack-item-popped', refreshUndoFlags)
undoManager.on('stack-cleared', refreshUndoFlags)

yDoc.on('update', () => {
  useStore.setState((s) => {
    const doc = yToDoc()
    const activeLayerId = doc.layers.some((l) => l.id === s.activeLayerId)
      ? s.activeLayerId
      : doc.layers.find((l) => l.id)?.id ?? ''
    return { doc, activeLayerId }
  })
})

// ---------- 协作连接 ----------

collab.setSelf(useStore.getState().selfName, useStore.getState().selfColor)
collab.setHandlers({
  onStatus: (s) => useStore.setState({ wsStatus: s }),
  onWelcome: (room, selfId, users) => {
    useStore.setState({
      room,
      selfId,
      users: Object.fromEntries(users.map((u) => [u.id, { ...u, cursor: null }])),
    })
  },
  onUsers: (users) =>
    useStore.setState({
      users: Object.fromEntries(
        users.map((u) => [u.id, { ...u, cursor: u.cursor ?? null }]),
      ),
    }),
  onError: (msg) => useStore.setState({ lastError: msg, wsStatus: 'offline' }),
})

export type { CanvasState }
