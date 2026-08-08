import { useState } from 'react'
import { useStore } from '../store'
import { smoothPoints, detectShape } from '../lib/aiDraw'
import { yDeleteItems, yPush, yUpdateStrokePoints, yUpdateItem } from '../lib/yroom'
import { createId } from '../lib/id'
import { nextSeq } from '../lib/seq'
import type { Pt } from '../types'

function extractPoints(points: unknown[]): Pt[] {
  return points.map((p) => {
    if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
      return { x: Number((p as { x: number }).x), y: Number((p as { y: number }).y) }
    }
    return { x: 0, y: 0 }
  }).filter((p) => isFinite(p.x) && isFinite(p.y))
}

function beautifyAll() {
  const s = useStore.getState()
  const strokeIds = s.selected.filter((id) => s.doc.strokes.some((st) => st.id === id))
  if (!strokeIds.length) return 0

  let count = 0
  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 3) continue

    const pts = extractPoints(st.points)
    if (pts.length < 3) continue

    const smoothed = smoothPoints(pts, 2)
    const detected = detectShape(smoothed)

    if (detected && detected.confidence > 0.85 && pts.length > 10) {
      yDeleteItems('strokes', [id])
      yPush('shapes', [{
        id: createId('sh'),
        kind: detected.kind,
        x0: detected.x0, y0: detected.y0,
        x1: detected.x1, y1: detected.y1,
        color: st.color,
        size: st.size,
        seq: nextSeq(),
        layer: st.layer,
      }])
    } else {
      yUpdateStrokePoints(id, smoothed)
    }
    count++
  }
  return count
}

function alignSelected() {
  const s = useStore.getState()
  const ids = s.selected
  if (ids.length < 2) return

  const items: { id: string; x: number; y: number; kind: 'stroke' | 'shape' | 'text' }[] = []
  for (const id of ids) {
    const sh = s.doc.shapes.find((x) => x.id === id)
    if (sh) {
      items.push({ id, x: (sh.x0 + sh.x1) / 2, y: (sh.y0 + sh.y1) / 2, kind: 'shape' })
      continue
    }
    const st = s.doc.strokes.find((x) => x.id === id)
    if (st && st.points.length > 0) {
      const xs = st.points.map((p) => (typeof p === 'object' && 'x' in p ? Number(p.x) : 0))
      const ys = st.points.map((p) => (typeof p === 'object' && 'y' in p ? Number(p.y) : 0))
      items.push({ id, x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length, kind: 'stroke' })
    }
  }
  if (items.length < 2) return

  const avgX = items.reduce((a, b) => a + b.x, 0) / items.length
  const avgY = items.reduce((a, b) => a + b.y, 0) / items.length

  for (const item of items) {
    const dx = avgX - item.x
    const dy = avgY - item.y
    if (item.kind === 'shape') {
      const sh = s.doc.shapes.find((x) => x.id === item.id)!
      yUpdateItem('shapes', sh.id, {
        x0: sh.x0 + dx, y0: sh.y0 + dy,
        x1: sh.x1 + dx, y1: sh.y1 + dy,
      })
    } else if (item.kind === 'stroke') {
      const st = s.doc.strokes.find((x) => x.id === item.id)!
      const newPts = st.points.map((p) => {
        if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
          return { x: Number(p.x) + dx, y: Number(p.y) + dy }
        }
        return p
      })
      yUpdateStrokePoints(st.id, newPts as Pt[])
    }
  }
}

export default function AIPanel() {
  const [msg, setMsg] = useState('')
  const hasStrokes = useStore((s) => s.selected.some((id) => s.doc.strokes.some((st) => st.id === id)))
  const hasMultiple = useStore((s) => s.selected.length >= 2)

  const handleBeautify = () => {
    const n = beautifyAll()
    setMsg(n > 0 ? `已美化 ${n} 条笔画` : '请先选中笔画')
    setTimeout(() => setMsg(''), 2000)
  }

  const handleAlign = () => {
    alignSelected()
    setMsg('已居中对齐')
    setTimeout(() => setMsg(''), 2000)
  }

  if (!hasStrokes && !hasMultiple) return null

  return (
    <div className="pointer-events-auto absolute right-3 bottom-16 z-20 flex flex-col items-end gap-1.5">
      {msg && (
        <div className="rounded-full bg-violet-600 px-3 py-1 text-[11px] text-white shadow animate-fade-up">
          {msg}
        </div>
      )}
      <div className="flex flex-col gap-1 rounded-xl border border-violet-200 bg-white/95 p-1.5 shadow-lg">
        {hasStrokes && (
          <button onClick={handleBeautify}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-violet-50 transition-colors">
            <span className="text-sm">✨</span>
            <div>
              <div className="text-[11px] text-zinc-800">美化笔画</div>
              <div className="text-[9px] text-zinc-400">平滑 + 形状识别</div>
            </div>
          </button>
        )}
        {hasMultiple && (
          <button onClick={handleAlign}
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-violet-50 transition-colors">
            <span className="text-sm">📐</span>
            <div>
              <div className="text-[11px] text-zinc-800">居中对齐</div>
              <div className="text-[9px] text-zinc-400">选中元素中心对齐</div>
            </div>
          </button>
        )}
      </div>
    </div>
  )
}
