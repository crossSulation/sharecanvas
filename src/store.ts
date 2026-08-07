import { create } from 'zustand'
import type { Camera2D, Doc, Obj3D, ObjKind, RemoteUser, StrokeKind, Tool, ViewMode, WsStatus } from './types'
import { createId } from './lib/id'
import { collab } from './lib/collab'
import { loadPrefs, savePrefs } from './lib/storage'
import {
  DEFAULT_LAYER_ID,
  transactLocal,
  yClearAll,
  yDeleteItems,
  yDoc,
  yInsertAt,
  yLayers,
  yObjects,
  yPush,
  yReplace,
  yToDoc,
  yUpdateItem,
  undoManager,
  importDocIntoY,
} from './lib/yroom'

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

export interface CanvasState {
  doc: Doc
  canUndo: boolean
  canRedo: boolean
  camera: Camera2D
  viewport: { w: number; h: number }
  mode: ViewMode
  tool: Tool
  color: string
  size: number
  brushStyle: StrokeKind
  selected: string[]
  selected3d: string | null
  activeLayerId: string
  layerPanelOpen: boolean
  users: Record<string, RemoteUser>
  selfId: string
  selfName: string
  selfColor: string
  room: string | null
  wsStatus: WsStatus
  penDetected: boolean
  lastError: string | null
  shareOpen: boolean
  set(p: Partial<CanvasState>): void
  setCamera(p: Partial<Camera2D>): void
  setViewport(v: { w: number; h: number }): void
  setMode(m: ViewMode): void
  setTool(t: Tool): void
  setColor(c: string): void
  setSize(s: number): void
  setBrushStyle(k: StrokeKind): void
  select(ids: string[]): void
  select3d(id: string | null): void
  setSelf(name: string, color: string): void
  undo(): void
  redo(): void
  deleteSelected(): void
  setActiveLayer(id: string): void
  setLayerPanelOpen(v: boolean): void
  addLayer(): void
  removeLayer(id: string): void
  renameLayer(id: string, name: string): void
  moveLayer(id: string, dir: -1 | 1): void
  setLayerVisible(id: string, v: boolean): void
  setLayerLocked(id: string, v: boolean): void
  setLayerOpacity(id: string, v: number): void
  clearScreen(): void
  clearAll(): void
  importDoc(doc: Doc): void
  addObject(kind: ObjKind): void
  updateObject3d(id: string, patch: Partial<Omit<Obj3D, 'id' | 'kind'>>): void
  removeObject3d(id: string): void
  duplicateObject3d(id: string): void
  setShareOpen(v: boolean): void
  setPenDetected(v?: boolean): void
}

export const useStore = create<CanvasState>()((set, get) => ({
  doc: yToDoc(),
  canUndo: false,
  canRedo: false,
  camera: { x: 0, y: 0, zoom: 1 },
  viewport: { w: 0, h: 0 },
  mode: '2d',
  tool: 'pen',
  color: prefs.color || '#18181b',
  size: 4,
  brushStyle: 'pen',
  selected: [],
  selected3d: null,
  activeLayerId: yToDoc().layers[0]?.id ?? '',
  layerPanelOpen: false,
  users: {},
  selfId: '',
  selfName: prefs.name || '涂鸦者',
  selfColor: prefs.color || '#52525b',
  room: null,
  wsStatus: 'offline',
  penDetected: false,
  lastError: null,
  shareOpen: false,

  set: (p) => set(p),
  setCamera: (p) => set((s) => ({ camera: { ...s.camera, ...p } })),
  setViewport: (v) => set((s) => (s.viewport.w === v.w && s.viewport.h === v.h ? {} : { viewport: v })),
  setMode: (m) => set({ mode: m }),
  setTool: (t) => set({ tool: t }),
  setColor: (c) => set({ color: c }),
  setSize: (s) => set({ size: s }),
  setBrushStyle: (k) => set({ brushStyle: k, tool: 'pen' }),
  select: (ids) => set({ selected: ids }),
  select3d: (id) => set({ selected3d: id }),
  setSelf: (name, color) => {
    savePrefs(name, color)
    collab.setSelf(name, color)
    set({ selfName: name, selfColor: color })
  },

  undo: () => undoManager.undo(),
  redo: () => undoManager.redo(),
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
    const eff = (l?: string) => (l && d.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID)
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

  // 只清除当前视野内的 2D 内容，视野外的保留
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
    const eff = (l?: string) => (l && d.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID)
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
      d.strokes.filter((st) => !(isEditable(st.layer) && st.points.some((p) => inView(p.x, p.y)))),
    )
    yReplace('shapes', keepShapes)
    yReplace(
      'texts',
      d.texts.filter(
        (t) =>
          (t.attachId ? !removedShapes.has(t.attachId) : !(isEditable(t.layer) && inView(t.x, t.y))),
      ),
    )
  },
  clearAll: () => {
    yClearAll()
    yPush('layers', [{ id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 }])
    set({ selected: [], selected3d: null, activeLayerId: DEFAULT_LAYER_ID })
  },
  importDoc: (doc) => {
    importDocIntoY(doc)
    set({ selected: [], selected3d: null })
  },

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
    const o = yObjects.toArray().map((m) => m.toJSON() as unknown as Obj3D).find((x) => x.id === id)
    if (!o) return
    yPush('objects', [
      {
        ...structuredClone(o),
        id: createId('o'),
        pos: [o.pos[0] + 0.6, o.pos[1], o.pos[2] + 0.6],
      },
    ])
  },
  setShareOpen: (v) => set({ shareOpen: v }),
  setPenDetected: (v = true) => set((s) => (s.penDetected === v ? {} : { penDetected: v })),
}))

// ---------- Yjs 变更 -> 镜像文档 + 防抖持久化 ----------

function refreshUndoFlags(): void {
  useStore.setState({ canUndo: undoManager.canUndo(), canRedo: undoManager.canRedo() })
}

undoManager.on('stack-item-added', refreshUndoFlags)
undoManager.on('stack-item-popped', refreshUndoFlags)
undoManager.on('stack-cleared', refreshUndoFlags)

yDoc.on('update', () => {
  useStore.setState((s) => {
    const doc = yToDoc()
    const activeLayerId = doc.layers.some((l) => l.id === s.activeLayerId)
      ? s.activeLayerId
      : doc.layers[0]?.id ?? ''
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
      users: Object.fromEntries(users.map((u) => [u.id, { ...u, cursor: u.cursor ?? null }])),
    }),
  onError: (msg) => useStore.setState({ lastError: msg, wsStatus: 'offline' }),
})
