import { useState, useRef, useEffect, useCallback } from 'react'
import type { Pt } from '../types'

const CANVAS_W = 400
const CANVAS_H = 400

interface Sample {
  label: string
  strokes: Pt[][]  // 每个笔画是一组点
}

export default function TrainCollector() {
  const [label, setLabel] = useState('')
  const [samples, setSamples] = useState<Sample[]>([])
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const strokesRef = useRef<Pt[][]>([])
  const activeRef = useRef<Pt[]>([])
  const [strokeCount, setStrokeCount] = useState(0)

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2000) }

  const drawAll = useCallback(() => {
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
    const allStrokes = [...strokesRef.current, activeRef.current]
    for (const pts of allStrokes) {
      if (pts.length > 1) {
        ctx.beginPath()
        ctx.moveTo(pts[0]!.x, pts[0]!.y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y)
        ctx.stroke()
      }
    }
    // 画笔画端点标记，帮助对齐连接
    ctx.fillStyle = '#ef4444'
    for (let i = 0; i < strokesRef.current.length; i++) {
      const pts = strokesRef.current[i]!
      if (pts.length > 0) {
        // 起点：蓝色
        ctx.fillStyle = '#3b82f6'
        ctx.beginPath(); ctx.arc(pts[0]!.x, pts[0]!.y, 4, 0, Math.PI * 2); ctx.fill()
        // 终点：红色
        ctx.fillStyle = '#ef4444'
        ctx.beginPath(); ctx.arc(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, 4, 0, Math.PI * 2); ctx.fill()
      }
    }
  }, [])

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
    activeRef.current = [toCanvas(e)]
    drawAll()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    activeRef.current.push(toCanvas(e))
    const pts = activeRef.current
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
    if (drawingRef.current && activeRef.current.length >= 2) {
      strokesRef.current.push([...activeRef.current])
      setStrokeCount((c) => c + 1)
    }
    activeRef.current = []
    drawingRef.current = false
    drawAll()
  }

  const handleUndo = () => {
    if (strokesRef.current.length > 0) {
      strokesRef.current.pop()
      setStrokeCount((c) => c - 1)
      drawAll()
    }
  }

  const handleConfirm = () => {
    if (!label.trim()) { flash('请先输入标签'); return }
    const totalPts = strokesRef.current.flat()
    if (totalPts.length < 5) { flash('笔迹太短，请重新绘制'); return }
    const normalized: Pt[][] = strokesRef.current.map((stroke) =>
      stroke.map((p) => ({
        x: (p.x / CANVAS_W) * 2 - 1,
        y: (p.y / CANVAS_H) * 2 - 1,
      }))
    )
    setSamples((prev) => [...prev, { label: label.trim(), strokes: normalized }])
    strokesRef.current = []
    activeRef.current = []
    setStrokeCount(0)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isTauri = !!(window as any).__TAURI_INTERNALS__
      if (isTauri) {
        const { invoke } = await import('@tauri-apps/api/core')
        const msg = await invoke<string>('save_training_samples', { samples })
        flash(`已保存到设备：${msg}`)
      } else {
        // Tauri WebView 中 fetch 相对路径会被解析到 tauri.localhost
        // 需要用完整 URL 走 Vite proxy 到开发机 Node.js 后端
        const base = location.origin || 'http://localhost:5173'
        const res = await fetch(`${base}/api/train/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ samples }),
        })
        if (res.ok) {
          const data = await res.json()
          flash(`已提交 ${data.count} 条样本 → ${data.dir}`)
        } else {
          flash('提交失败')
        }
      }
      setSamples([])
    } catch (e) {
      flash('提交失败：' + String(e))
    }
    setUploading(false)
  }

  const clearSamples = () => setSamples([])

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-100 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-300 bg-white p-5 shadow-lg">
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
          className="mb-2 w-full rounded-lg border border-zinc-300 bg-white"
          style={{ touchAction: 'none', height: CANVAS_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] text-zinc-400">笔画数：{strokeCount}</span>
          <button
            onClick={handleUndo}
            disabled={strokeCount === 0}
            className="text-[10px] text-zinc-500 hover:text-red-500 disabled:opacity-30"
          >
            撤销上笔
          </button>
        </div>

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
              : '可画多笔合成一个形状'}
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
