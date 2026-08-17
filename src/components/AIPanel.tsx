import { useState } from 'react'
import { useStore } from '../store'
import { beautifySelected } from '../lib/aiBackend'
import { yUpdateStrokePoints, yUpdateItem } from '../lib/yroom'
import type { Pt } from '../types'

interface AlignItem { id: string; x: number; y: number; kind: 'stroke' | 'shape' | 'text' }

function collectItems(): AlignItem[] {
  const s = useStore.getState()
  const items: AlignItem[] = []
  for (const id of s.selected) {
    const sh = s.doc.shapes.find((x) => x.id === id)
    if (sh) { items.push({ id, x: (sh.x0 + sh.x1) / 2, y: (sh.y0 + sh.y1) / 2, kind: 'shape' }); continue }
    const st = s.doc.strokes.find((x) => x.id === id)
    if (st && st.points.length > 0) {
      const xs = st.points.map((p) => (typeof p === 'object' && 'x' in p ? Number(p.x) : 0))
      const ys = st.points.map((p) => (typeof p === 'object' && 'y' in p ? Number(p.y) : 0))
      items.push({ id, x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length, kind: 'stroke' })
    }
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
  }
}

function alignHorizontal() {
  const items = collectItems()
  if (items.length < 2) return
  const targetX = items.reduce((a, b) => a + b.x, 0) / items.length
  for (const item of items) moveItem(item.id, item.kind, targetX - item.x, 0)
}

function alignVertical() {
  const items = collectItems()
  if (items.length < 2) return
  const targetY = items.reduce((a, b) => a + b.y, 0) / items.length
  for (const item of items) moveItem(item.id, item.kind, 0, targetY - item.y)
}

function distributeHorizontal() {
  const items = collectItems()
  if (items.length < 3) return
  items.sort((a, b) => a.x - b.x)
  const first = items[0]!, last = items[items.length - 1]!
  for (let i = 1; i < items.length - 1; i++) {
    const targetX = first.x + (last.x - first.x) * i / (items.length - 1)
    moveItem(items[i]!.id, items[i]!.kind, targetX - items[i]!.x, 0)
  }
}

function distributeVertical() {
  const items = collectItems()
  if (items.length < 3) return
  items.sort((a, b) => a.y - b.y)
  const first = items[0]!, last = items[items.length - 1]!
  for (let i = 1; i < items.length - 1; i++) {
    const targetY = first.y + (last.y - first.y) * i / (items.length - 1)
    moveItem(items[i]!.id, items[i]!.kind, 0, targetY - items[i]!.y)
  }
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
    { label: '水平居中', desc: 'X 轴中心对齐', icon: '↔', fn: () => { alignHorizontal(); setMsg('已水平居中'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
    { label: '垂直居中', desc: 'Y 轴中心对齐', icon: '↕', fn: () => { alignVertical(); setMsg('已垂直居中'); setTimeout(() => setMsg(''), 1500) }, show: hasMultiple },
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
