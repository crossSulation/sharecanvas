import { useState } from 'react'
import { useStore } from '../store'
import { beautifySelected } from '../lib/aiBackend'
import { yUpdateStrokePoints, yUpdateItem } from '../lib/yroom'
import { clusterStrokeGroups } from '../lib/structure'
import { itemBounds } from './canvasHelpers'
import type { Pt, Stroke } from '../types'

interface AlignItem {
  ids: string[]
  kinds: ('stroke' | 'shape' | 'text')[]
  cx: number
  cy: number
  box: { x0: number; y0: number; x1: number; y1: number }
}

function unionBox(boxes: { x0: number; y0: number; x1: number; y1: number }[]) {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  }
}

function boxesOverlap(a: AlignItem, b: AlignItem): boolean {
  return a.box.x1 >= b.box.x0 && b.box.x1 >= a.box.x0 && a.box.y1 >= b.box.y0 && b.box.y1 >= a.box.y0
}

const pairKey = (i: number, j: number) => (i < j ? `${i}-${j}` : `${j}-${i}`)

// 收集选中的“绘制体”：
// - 笔画按空间聚类合并（多笔一个图形算一个绘制体，避免对齐时拆散）
// - 形状通过 arrow 的 attach 关系连通（箭头+两端形状算一个绘制体）
// - 文字独立成体
function collectItems(): AlignItem[] {
  const s = useStore.getState()
  const items: AlignItem[] = []

  // 形状连通分量（arrow 的 attach 作为边）
  const selShapes = s.selected.filter((id) => s.doc.shapes.some((sh) => sh.id === id))
  const parent = new Map<string, string>(selShapes.map((id) => [id, id]))
  const find = (a: string): string => {
    const p = parent.get(a)!
    if (p === a) return a
    const r = find(p)
    parent.set(a, r)
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (const id of selShapes) {
    const sh = s.doc.shapes.find((x) => x.id === id)!
    if (sh.attachStartId && parent.has(sh.attachStartId)) union(id, sh.attachStartId)
    if (sh.attachEndId && parent.has(sh.attachEndId)) union(id, sh.attachEndId)
  }
  const shapeGroups = new Map<string, string[]>()
  for (const id of selShapes) {
    const root = find(id)
    const g = shapeGroups.get(root) ?? []
    g.push(id)
    shapeGroups.set(root, g)
  }
  for (const group of shapeGroups.values()) {
    const box = unionBox(group.map((id) => itemBounds(s.doc.shapes.find((x) => x.id === id)!)))
    items.push({ ids: group, kinds: group.map(() => 'shape' as const), cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, box })
  }

  for (const id of s.selected) {
    const t = s.doc.texts.find((x) => x.id === id)
    if (t) {
      const box = itemBounds(t)
      items.push({ ids: [t.id], kinds: ['text'], cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, box })
    }
  }

  // 笔画空间聚类（相连笔画 = 一个图形）
  const strokes = s.selected
    .map((id) => s.doc.strokes.find((st) => st.id === id))
    .filter((st): st is Stroke => !!st)
  for (const group of clusterStrokeGroups(strokes)) {
    const box = unionBox(group.map((id) => itemBounds(s.doc.strokes.find((st) => st.id === id)!)))
    items.push({ ids: group, kinds: group.map(() => 'stroke' as const), cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, box })
  }
  return items
}

function moveItem(id: string, kind: 'stroke' | 'shape' | 'text', dx: number, dy: number) {
  const s = useStore.getState()
  if (kind === 'shape') {
    const sh = s.doc.shapes.find((x) => x.id === id)!
    yUpdateItem('shapes', sh.id, { x0: sh.x0 + dx, y0: sh.y0 + dy, x1: sh.x1 + dx, y1: sh.y1 + dy })
  } else if (kind === 'stroke') {
    const st = s.doc.strokes.find((x) => x.id === id)!
    const newPts = st.points.map((p) => {
      if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
        return { x: Number(p.x) + dx, y: Number(p.y) + dy }
      }
      return p
    })
    yUpdateStrokePoints(st.id, newPts as Pt[])
  } else if (kind === 'text') {
    const t = s.doc.texts.find((x) => x.id === id)!
    yUpdateItem('texts', t.id, { x: t.x + dx, y: t.y + dy })
  }
}

function moveItems(it: AlignItem, dx: number, dy: number) {
  if (!dx && !dy) return
  for (let i = 0; i < it.ids.length; i++) moveItem(it.ids[i]!, it.kinds[i]!, dx, dy)
  it.box = { x0: it.box.x0 + dx, y0: it.box.y0 + dy, x1: it.box.x1 + dx, y1: it.box.y1 + dy }
  it.cx += dx
  it.cy += dy
}

// bbox 碰撞检测：把“对齐后新产生”的重叠推开（对齐前就重叠的绘制体视为连接/一体，不拆开）
function resolveNewOverlaps(items: AlignItem[], pushAxis: 'x' | 'y', preOverlap: Set<string>) {
  for (let pass = 0; pass < Math.max(items.length, 3); pass++) {
    let moved = false
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (preOverlap.has(pairKey(i, j))) continue
        const a = items[i]!
        const b = items[j]!
        const overlap =
          pushAxis === 'x'
            ? Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0)
            : Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0)
        if (overlap <= 0) continue
        const half = overlap / 2 + 2
        if (pushAxis === 'x') {
          const dir = a.cx < b.cx ? 1 : -1
          moveItems(a, -dir * half, 0)
          moveItems(b, dir * half, 0)
        } else {
          const dir = a.cy < b.cy ? 1 : -1
          moveItems(a, 0, -dir * half)
          moveItems(b, 0, dir * half)
        }
        moved = true
      }
    }
    if (!moved) break
  }
}

function preOverlapPairs(items: AlignItem[]): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (boxesOverlap(items[i]!, items[j]!)) set.add(pairKey(i, j))
    }
  }
  return set
}

function alignHorizontal() {
  const items = collectItems()
  if (items.length < 2) return
  const preOverlap = preOverlapPairs(items)
  const targetX = items.reduce((a, b) => a + b.cx, 0) / items.length
  for (const it of items) moveItems(it, targetX - it.cx, 0)
  resolveNewOverlaps(items, 'y', preOverlap)
}

function alignVertical() {
  const items = collectItems()
  if (items.length < 2) return
  const preOverlap = preOverlapPairs(items)
  const targetY = items.reduce((a, b) => a + b.cy, 0) / items.length
  for (const it of items) moveItems(it, 0, targetY - it.cy)
  resolveNewOverlaps(items, 'x', preOverlap)
}

function distributeHorizontal() {
  const items = collectItems()
  if (items.length < 3) return
  items.sort((a, b) => a.cx - b.cx)
  const preOverlap = preOverlapPairs(items)
  const first = items[0]!, last = items[items.length - 1]!
  for (let i = 1; i < items.length - 1; i++) {
    const targetX = first.cx + (last.cx - first.cx) * i / (items.length - 1)
    moveItems(items[i]!, targetX - items[i]!.cx, 0)
  }
  resolveNewOverlaps(items, 'x', preOverlap)
}

function distributeVertical() {
  const items = collectItems()
  if (items.length < 3) return
  items.sort((a, b) => a.cy - b.cy)
  const preOverlap = preOverlapPairs(items)
  const first = items[0]!, last = items[items.length - 1]!
  for (let i = 1; i < items.length - 1; i++) {
    const targetY = first.cy + (last.cy - first.cy) * i / (items.length - 1)
    moveItems(items[i]!, 0, targetY - items[i]!.cy)
  }
  resolveNewOverlaps(items, 'y', preOverlap)
}

export default function AIPanel() {
  const [msg, setMsg] = useState('')
  const hasStrokes = useStore((s) => s.selected.some((id) => s.doc.strokes.some((st) => st.id === id)))
  const hasMultiple = useStore((s) => s.selected.length >= 2)

  const handleBeautify = async (smoothOnly = false) => {
    const res = await beautifySelected(smoothOnly)
    if (res.structure) {
      const labels: Record<string, string> = { flowchart: '流程图', barchart: '柱状图', table: '表格' }
      setMsg(`识别到${labels[res.structure.type] ?? res.structure.type}并美化（${Math.round(res.structure.confidence * 100)}%）`)
    } else if (res.count > 0) {
      setMsg(smoothOnly ? `已平滑 ${res.count} 条笔画` : `已美化 ${res.count} 条笔画`)
    } else {
      setMsg('请先选中笔画')
    }
    setTimeout(() => setMsg(''), 2000)
  }

  const actions: { label: string; desc: string; icon: string; fn: () => void; show: boolean }[] = [
    { label: '美化笔画', desc: '平滑 + 形状识别', icon: '✨', fn: () => handleBeautify(false), show: hasStrokes },
    { label: '仅平滑', desc: '不识别形状，保留手写', icon: '≈', fn: () => handleBeautify(true), show: hasStrokes },
    { label: '水平居中', desc: 'Y 轴中心对齐（排成一行）', icon: '↕', fn: () => { alignVertical(); setMsg('已水平居中'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
    { label: '垂直居中', desc: 'X 轴中心对齐（排成一列）', icon: '↔', fn: () => { alignHorizontal(); setMsg('已垂直居中'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
    { label: '水平分布', desc: 'X 轴等距排列', icon: '⇉', fn: () => { distributeHorizontal(); setMsg('已水平等距分布'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
    { label: '垂直分布', desc: 'Y 轴等距排列', icon: '⇊', fn: () => { distributeVertical(); setMsg('已垂直等距分布'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
  ]

  return (
    <div className="pointer-events-auto absolute right-3 bottom-16 z-20 flex flex-col items-end gap-1.5">
      {msg && (
        <div className="rounded-full bg-violet-600 px-3 py-1 text-[11px] text-white shadow animate-fade-up">
          {msg}
        </div>
      )}
      <div className="flex flex-col gap-0.5 rounded-xl border border-violet-200 bg-white/95 p-1.5 shadow-lg">
        {actions.filter((a) => a.show).map((a) => (
          <button key={a.label} onClick={a.fn}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-violet-50 transition-colors">
            <span className="text-sm w-4 text-center">{a.icon}</span>
            <div>
              <div className="text-[11px] text-zinc-800">{a.label}</div>
              <div className="text-[9px] text-zinc-400">{a.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
