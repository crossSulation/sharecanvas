import { useStore } from '../store'
import { createId } from './id'
import { nextSeq } from './seq'
import { yPush } from './yroom'
import type { Shape, Stroke, TextItem } from '../types'

type ClipboardItem = { kind: 'stroke' | 'shape' | 'text'; item: Stroke | Shape | TextItem }

let clipboard: ClipboardItem[] = []
let pasteCount = 0

export function copySelection(): void {
  const s = useStore.getState()
  const ids = new Set(s.selected)
  const items: ClipboardItem[] = []
  for (const st of s.doc.strokes) if (ids.has(st.id)) items.push({ kind: 'stroke', item: st })
  for (const sh of s.doc.shapes) if (ids.has(sh.id)) items.push({ kind: 'shape', item: sh })
  for (const t of s.doc.texts) if (ids.has(t.id)) items.push({ kind: 'text', item: t })
  // 被选中图形上附着的文字一并复制
  const shapeIds = new Set(
    items.filter((i) => i.kind === 'shape').map((i) => (i.item as Shape).id),
  )
  for (const t of s.doc.texts) {
    if (t.attachId && shapeIds.has(t.attachId)) items.push({ kind: 'text', item: t })
  }
  if (!items.length) return
  clipboard = items.map(({ kind, item }) => ({ kind, item: structuredClone(item) }))
  pasteCount = 0
}

export function pasteClipboard(): void {
  if (!clipboard.length) return
  const s = useStore.getState()
  pasteCount += 1
  const dx = 24 * pasteCount
  const dy = 24 * pasteCount
  const layerOf = (l?: string) =>
    l && s.doc.layers.some((x) => x.id === l) ? l : s.activeLayerId

  // 旧 id -> 新 id，用于重挂箭头吸附与文字附着
  const idMap = new Map<string, string>()
  for (const c of clipboard) {
    if (c.kind === 'shape') {
      const sh = c.item as Shape
      idMap.set(sh.id, createId('sh'))
    }
  }

  const pastedIds: string[] = []
  const strokes: object[] = []
  const shapes: object[] = []
  const texts: object[] = []

  for (const c of clipboard) {
    if (c.kind === 'stroke') {
      const st = c.item as Stroke
      const id = createId('s')
      pastedIds.push(id)
      strokes.push({
        ...st,
        id,
        seq: nextSeq(),
        layer: layerOf(st.layer),
        points: st.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
      })
    } else if (c.kind === 'shape') {
      const sh = c.item as Shape
      const id = idMap.get(sh.id) as string
      pastedIds.push(id)
      shapes.push({
        ...sh,
        id,
        seq: nextSeq(),
        layer: layerOf(sh.layer),
        x0: sh.x0 + dx,
        y0: sh.y0 + dy,
        x1: sh.x1 + dx,
        y1: sh.y1 + dy,
        attachStartId: sh.attachStartId ? idMap.get(sh.attachStartId) : undefined,
        attachEndId: sh.attachEndId ? idMap.get(sh.attachEndId) : undefined,
      })
    } else {
      const t = c.item as TextItem
      const id = createId('t')
      pastedIds.push(id)
      texts.push({
        ...t,
        id,
        seq: nextSeq(),
        layer: layerOf(t.layer),
        x: t.x + dx,
        y: t.y + dy,
        attachId: t.attachId ? idMap.get(t.attachId) : undefined,
      })
    }
  }

  yPush('strokes', strokes)
  yPush('shapes', shapes)
  yPush('texts', texts)
  s.select(pastedIds)
}
