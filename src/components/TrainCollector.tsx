import { useState, useRef, useEffect, useCallback } from 'react'
import type { Pt } from '../types'

const CANVAS_W = 280
const CANVAS_H = 280

interface Sample {
  label: string
  points: Pt[]
}

export default function TrainCollector() {
  const [label, setLabel] = useState('')
  const [samples, setSamples] = useState<Sample[]>([])
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const pointsRef = useRef<Pt[]>([])
  const drawnRef = useRef(false)

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2000) }

  const drawCanvas = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.strokeStyle = '#18181b'
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pts = pointsRef.current
    if (pts.length > 1) {
      ctx.beginPath()
      ctx.moveTo(pts[0]!.x, pts[0]!.y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
      ctx.stroke()
    }
    drawnRef.current = true
  }, [])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    drawCanvas()
    return () => {}
  }, [drawCanvas])

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = canvasRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const c = canvasRef.current
    if (!c) return
    c.setPointerCapture(e.pointerId)
    drawingRef.current = true
    pointsRef.current = [toCanvas(e)]
    drawCanvas()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    pointsRef.current.push(toCanvas(e))
    const pts = pointsRef.current
    if (pts.length > 1) {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return
      ctx.strokeStyle = '#18181b'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[pts.length - 2]!.x, pts[pts.length - 2]!.y)
      ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y)
      ctx.stroke()
    }
  }

  const onPointerUp = () => {
    drawingRef.current = false
  }

  const handleConfirm = () => {
    if (!label.trim()) { flash('请先输入标签'); return }
    if (pointsRef.current.length < 5) { flash('笔迹太短，请重新绘制'); return }
    const normalized: Pt[] = pointsRef.current.map((p) => ({
      x: (p.x / CANVAS_W) * 2 - 1,
      y: (p.y / CANVAS_H) * 2 - 1,
    }))
    setSamples((prev) => [...prev, { label: label.trim(), points: normalized }])
    pointsRef.current = []
    const c = canvasRef.current
    if (c) {
      const ctx = c.getContext('2d')
      if (ctx) { ctx.clearRect(0, 0, CANVAS_W, CANVAS_H); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H) }
    }
    flash(`已保存 ${label.trim()}（共 ${samples.length + 1} 条）`)
  }

  const handleSubmit = async () => {
    if (!samples.length) { flash('没有可提交的样本'); return }
    setUploading(true)
    try {
      const res = await fetch('/api/train/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples }),
      })
      if (res.ok) {
        flash(`已提交 ${samples.length} 条样本`)
        setSamples([])
      } else {
        flash('提交失败')
      }
    } catch {
      flash('提交失败：无法连接服务器')
    }
    setUploading(false)
  }

  const clearSamples = () => setSamples([])

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-100 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-300 bg-white p-5 shadow-lg">
        <h2 className="mb-3 text-sm font-bold text-zinc-900">训练样本收集</h2>

        <div className="mb-3 flex items-center gap-2">
          <label className="shrink-0 text-xs text-zinc-600">标签：</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="rect / triangle / arrow …"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs outline-none focus:border-zinc-500"
          />
        </div>

        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="mb-3 w-full rounded-lg border border-zinc-300 bg-white"
          style={{ touchAction: 'none', height: CANVAS_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={handleConfirm}
            className="flex-1 rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-700"
          >
            确定（{samples.length}）
          </button>
          <button
            onClick={handleSubmit}
            disabled={uploading || !samples.length}
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
          >
            {uploading ? '提交中…' : '提交'}
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[10px] text-zinc-400">
            {samples.length > 0
              ? `已收集 ${samples.length} 条（${[...new Set(samples.map((s) => s.label))].join(', ')}）`
              : '画一笔 → 确定 → 重复'}
          </div>
          {samples.length > 0 && (
            <button
              onClick={clearSamples}
              className="text-[10px] text-zinc-400 hover:text-red-500"
            >
              清空
            </button>
          )}
        </div>

        {msg && (
          <div className="mt-3 rounded-lg bg-violet-50 px-3 py-2 text-[11px] text-violet-700 animate-fade-up">
            {msg}
          </div>
        )}
      </div>
    </div>
  )
}
