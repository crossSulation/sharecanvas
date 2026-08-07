import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Doc, EraseCircle, LayerInfo, Obj3D, Pt, Shape, Stroke, TextItem } from '../types'
import { initSeq } from './seq'
import { loadDoc } from './storage'

export const yDoc = new Y.Doc()
export const yStrokes: Y.Array<Y.Map<unknown>> = yDoc.getArray('strokes')
export const yShapes: Y.Array<Y.Map<unknown>> = yDoc.getArray('shapes')
export const yTexts: Y.Array<Y.Map<unknown>> = yDoc.getArray('texts')
export const yObjects: Y.Array<Y.Map<unknown>> = yDoc.getArray('objects')
export const yEraser: Y.Array<Y.Map<unknown>> = yDoc.getArray('eraser')
export const yLayers: Y.Array<Y.Map<unknown>> = yDoc.getArray('layers')

export type Collection = 'strokes' | 'shapes' | 'texts' | 'objects' | 'eraser' | 'layers'

export const DEFAULT_LAYER_ID = 'layer_default'

const COLLECTIONS: Record<Collection, Y.Array<Y.Map<unknown>>> = {
  strokes: yStrokes,
  shapes: yShapes,
  texts: yTexts,
  objects: yObjects,
  eraser: yEraser,
  layers: yLayers,
}

// 本地修改的 origin 标记；UndoManager 只跟踪本地事务
export const LOCAL = 'local'

export const undoManager = new Y.UndoManager(
  [yStrokes, yShapes, yTexts, yObjects, yEraser, yLayers],
  { trackedOrigins: new Set([LOCAL]), captureTimeout: 800 },
)

// 把“创建序号”计数器续到文档现有最大值，避免加载/远端同步后
// 新内容的序号小于旧擦除洞，导致擦除区无法再绘制
export function refreshSeqCounter(): void {
  let max = 0
  for (const arr of [yStrokes, yShapes, yTexts, yObjects, yEraser]) {
    for (const m of arr.toArray()) {
      const v = m.get('seq')
      if (typeof v === 'number' && v > max) max = v
    }
  }
  initSeq(max)
}

export function ensureDefaultLayer(): void {
  if (yLayers.length > 0) return
  yPush('layers', [{ id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 }])
}

export function transactLocal(fn: () => void): void {
  yDoc.transact(fn, LOCAL)
}

function yMap(obj: object): Y.Map<unknown> {
  const m = new Y.Map()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue
    m.set(k, encodeY(v))
  }
  return m
}

function encodeY(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = new Y.Array()
    a.push(v.map(encodeY))
    return a
  }
  if (v && typeof v === 'object') return yMap(v as object)
  return v
}

function decodeY(v: unknown): unknown {
  if (v instanceof Y.Map) {
    const out: Record<string, unknown> = {}
    v.forEach((val, key) => {
      out[key] = decodeY(val)
    })
    return out
  }
  if (v instanceof Y.Array) return v.toArray().map(decodeY)
  return v
}

function toItems(collection: Collection): unknown[] {
  return COLLECTIONS[collection].toArray().map(decodeY)
}

export function yToDoc(): Doc {
  return {
    version: 1,
    strokes: toItems('strokes') as unknown as Stroke[],
    shapes: toItems('shapes') as unknown as Shape[],
    texts: toItems('texts') as unknown as TextItem[],
    objects: toItems('objects') as unknown as Obj3D[],
    eraser: toItems('eraser') as unknown as EraseCircle[],
    layers: toItems('layers') as unknown as LayerInfo[],
  }
}

export function yPush(collection: Collection, items: object[]): void {
  transactLocal(() => {
    COLLECTIONS[collection].push(items.map((it) => yMap(it)))
  })
}

export function yInsertAt(collection: Collection, index: number, items: object[]): void {
  transactLocal(() => {
    const arr = COLLECTIONS[collection]
    arr.insert(Math.max(0, Math.min(index, arr.length)), items.map((it) => yMap(it)))
  })
}

export function yUpdateItem(collection: Collection, id: string, patch: Record<string, unknown>): void {
  transactLocal(() => {
    const m = COLLECTIONS[collection].toArray().find((x) => x.get('id') === id)
    if (!m) return
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) m.delete(k)
      else m.set(k, encodeY(v))
    }
  })
}

export function yUpdateStrokePoints(id: string, points: Pt[]): void {
  transactLocal(() => {
    const m = yStrokes.toArray().find((x) => x.get('id') === id)
    if (!m) return
    const arr = m.get('points') as Y.Array<Y.Map<unknown>>
    if (!arr) return
    arr.delete(0, arr.length)
    arr.push(points.map((p) => yMap(p)))
  })
}

export function yDeleteItems(collection: Collection, ids: string[]): void {
  if (!ids.length) return
  const idSet = new Set(ids)
  transactLocal(() => {
    const arr = COLLECTIONS[collection]
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr.get(i) as Y.Map<unknown>
      if (idSet.has(String(m.get('id')))) arr.delete(i, 1)
    }
  })
}

export function yReplace(collection: Collection, items: object[]): void {
  transactLocal(() => {
    const arr = COLLECTIONS[collection]
    arr.delete(0, arr.length)
    arr.push(items.map((it) => yMap(it)))
  })
}

export function yClearAll(): void {
  transactLocal(() => {
    for (const arr of Object.values(COLLECTIONS)) arr.delete(0, arr.length)
  })
}

export function importDocIntoY(doc: Doc): void {
  transactLocal(() => {
    for (const arr of Object.values(COLLECTIONS)) arr.delete(0, arr.length)
    for (const kind of ['strokes', 'shapes', 'texts', 'objects', 'eraser', 'layers'] as Collection[]) {
      COLLECTIONS[kind].push((doc[kind] as unknown as object[]).map((it) => yMap(it)))
    }
    if (yLayers.length === 0) {
      yPush('layers', [{ id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 }])
    }
  })
}

// ---------- 本地持久化：IndexedDB（y-indexeddb，只存增量更新，配额远大于 localStorage） ----------

const IDB_NAME = 'sharecanvas-doc'
const YJS_LEGACY_KEY = 'sharecanvas:yjs:v1'

export let persistence: IndexeddbPersistence | null = null

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 与 y-indexeddb 相同的建库方式，检查 updates store 是否已有数据
function idbHasRecords(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('updates')) db.createObjectStore('updates', { autoIncrement: true })
        if (!db.objectStoreNames.contains('custom')) db.createObjectStore('custom')
      }
      req.onsuccess = () => {
        try {
          const db = req.result
          if (!db.objectStoreNames.contains('updates')) {
            db.close()
            resolve(false)
            return
          }
          const tx = db.transaction('updates', 'readonly')
          const count = tx.objectStore('updates').count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result > 0)
          }
          count.onerror = () => {
            db.close()
            resolve(false)
          }
        } catch {
          resolve(false)
        }
      }
      req.onerror = () => resolve(false)
      req.onblocked = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

// 启动时恢复：IndexedDB 为空时迁移旧的 localStorage 数据（Yjs 更新或更早的 JSON 文档）
export async function initPersistence(): Promise<void> {
  try {
    const legacy = localStorage.getItem(YJS_LEGACY_KEY)
    const hasIdbData = await idbHasRecords()
    if (!hasIdbData) {
      if (legacy) {
        Y.applyUpdate(yDoc, base64ToBytes(legacy))
      } else {
        const legacyJson = loadDoc()
        if (legacyJson) importDocIntoY(legacyJson)
      }
    }
    if (legacy) localStorage.removeItem(YJS_LEGACY_KEY)
  } catch {
    /* 迁移失败不阻塞启动 */
  }
  if (!persistence) {
    persistence = new IndexeddbPersistence(IDB_NAME, yDoc)
    await persistence.whenSynced.catch(() => {})
  }
  ensureDefaultLayer()
  refreshSeqCounter()
}

// 远端同步可能带来更大的序号，收到非本地更新时续接计数器
yDoc.on('update', (_update, origin) => {
  if (origin !== LOCAL) refreshSeqCounter()
})
