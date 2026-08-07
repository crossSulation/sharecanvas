import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { collab } from '../lib/collab'
import { createId } from '../lib/id'
import { nextSeq } from '../lib/seq'
import { tickFps, recordDrawTime } from '../lib/perf'
import { DEFAULT_LAYER_ID, yDeleteItems, yPush, yUpdateItem, yUpdateStrokePoints } from '../lib/yroom'
import {
  shapeCenter,
  shapeEdgePoint,
  textWorldPos,
} from '../lib/layerRender'
import type { Doc, EraseCircle, Pt, Shape, Stroke, TextItem } from '../types'
import {
  clamp,
  drawGestureOverlay,
  drawGrid,
  eraserRadius,
  findItem,
  getSelectionBounds,
  hitResizeHandle,
  hitShape,
  hitTest,
  itemBounds,
  PEN_CURSOR,
  rasterizeLayerSync,
  roundRectPath,
} from './canvasHelpers'
import type { Interaction, ItemRef, LayerCache, RasterParams } from './canvasHelpers'

export default function Canvas2D() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layerCacheRef = useRef(new Map<string, LayerCache>())
  const dirtyLayersRef = useRef(new Set<string>())
  const lastDocRef = useRef<Doc | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const workerOkRef = useRef(true)
  const inflightRef = useRef(new Set<string>())
  const pendingRasterRef = useRef(new Map<string, RasterParams>())
  const suppressInvalidationRef = useRef(false)
  const gestureLayerIdRef = useRef<string | null>(null)
  const doc = useStore((s) => s.doc)
  const camera = useStore((s) => s.camera)
  const tool = useStore((s) => s.tool)
  const size = useStore((s) => s.size)
  const selected = useStore((s) => s.selected)
  const users = useStore((s) => s.users)
  const selfId = useStore((s) => s.selfId)
  const stateRef = useRef({ doc, camera, tool, size, selected, users, selfId })
  // eslint-disable-next-line react-hooks/refs -- reactive ref pattern: always reflects latest state for event handlers
  stateRef.current = { doc, camera, tool, size, selected, users, selfId }

  const pointersRef = useRef(new Map<number, { x: number; y: number; type: string }>())
  const interactionRef = useRef<Interaction | null>(null)
  const spaceRef = useRef(false)
  const hoverRef = useRef<Pt | null>(null)
  const viewportRef = useRef({ w: 0, h: 0 })
  const drawRef = useRef<() => void>(() => {})
  // 远端用户光标的平滑显示位置（世界坐标，逐帧向目标收敛）
  const remoteCursorRef = useRef(new Map<string, Pt>())

  const [textDraft, setTextDraft] = useState<{ id: string; world: Pt; openedAt: number } | null>(null)
  const [textValue, setTextValue] = useState('')
  const textInputRef = useRef<HTMLInputElement>(null)

  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const c = canvasRef.current
    if (!c) return { x: 0, y: 0 }
    const rect = c.getBoundingClientRect()
    const { camera: cam } = useStore.getState()
    return {
      x: (clientX - rect.left - rect.width / 2) / cam.zoom + cam.x,
      y: (clientY - rect.top - rect.height / 2) / cam.zoom + cam.y,
    }
  }, [])

  const toScreen = useCallback((w: Pt): Pt => {
    const { camera: cam } = useStore.getState()
    const { w: vw, h: vh } = viewportRef.current
    return { x: (w.x - cam.x) * cam.zoom + vw / 2, y: (w.y - cam.y) * cam.zoom + vh / 2 }
  }, [])

  const pumpRaster = useCallback((id: string) => {
    const p = pendingRasterRef.current.get(id)
    if (!p) return
    pendingRasterRef.current.delete(id)
    inflightRef.current.add(id)
    workerRef.current?.postMessage(p)
  }, [])

  const requestRaster = useCallback((params: RasterParams) => {
    pendingRasterRef.current.set(params.layerId, params)
    if (!inflightRef.current.has(params.layerId)) pumpRaster(params.layerId)
  }, [pumpRaster])

  const draw = useCallback(() => {
    const drawStart = performance.now()
    tickFps()
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const st = useStore.getState()
    const { w, h } = viewportRef.current
    const dpr = window.devicePixelRatio || 1
    const zoom = st.camera.zoom
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // 网格直接画在可见画布上（不被橡皮擦打洞）
    ctx.save()
    ctx.translate(w / 2 - st.camera.x * zoom, h / 2 - st.camera.y * zoom)
    ctx.scale(zoom, zoom)
    drawGrid(ctx, st.camera, w, h)
    ctx.restore()

    // 分层渲染：每层内容缓存为“屏幕空间位图”。
    // 平移只做位图合成；内容变更/缩放变化/移出缓存范围时才重光栅化该层。
    const layers = st.doc.layers.length
      ? st.doc.layers
      : [{ id: DEFAULT_LAYER_ID, name: '图层 1', visible: true, locked: false, opacity: 1 }]

    if (lastDocRef.current !== st.doc && !suppressInvalidationRef.current) {
      lastDocRef.current = st.doc
      for (const l of layers) dirtyLayersRef.current.add(l.id)
    }

    const hw = w / 2
    const hh = h / 2
    const halfW = hw / zoom
    const halfH = hh / zoom
    const MARGIN = 1.4
    const itNow = interactionRef.current
    const eraseActive = itNow?.type === 'erase'
    const eraseLayer = eraseActive ? st.activeLayerId : null

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (!layer.visible) {
        layerCacheRef.current.delete(layer.id)
        continue
      }
      const cache = layerCacheRef.current.get(layer.id)
      const cw = Math.max(1, Math.ceil(halfW * MARGIN * 2 * zoom * dpr))
      const ch = Math.max(1, Math.ceil(halfH * MARGIN * 2 * zoom * dpr))
      const outOfRange =
        Math.abs(st.camera.x - (cache?.cam.x ?? Number.POSITIVE_INFINITY)) > halfW * (MARGIN - 1) ||
        Math.abs(st.camera.y - (cache?.cam.y ?? Number.POSITIVE_INFINITY)) > halfH * (MARGIN - 1)
      const forceSync = eraseActive && layer.id === eraseLayer
      const needRaster =
        forceSync ||
        !cache ||
        dirtyLayersRef.current.has(layer.id) ||
        cache.zoom !== zoom ||
        cache.width !== cw ||
        cache.height !== ch ||
        outOfRange

      if (needRaster) {
        if (forceSync || !workerOkRef.current || !workerRef.current) {
          layerCacheRef.current.set(
            layer.id,
            rasterizeLayerSync(
              cache,
              st.doc,
              layer.id,
              layer.opacity,
              st.camera,
              zoom,
              w,
              h,
              dpr,
              MARGIN,
            ),
          )
        } else {
          requestRaster({
            type: 'raster',
            layerId: layer.id,
            doc: st.doc,
            camera: { x: st.camera.x, y: st.camera.y },
            zoom,
            viewport: { w, h },
            dpr,
            margin: MARGIN,
            layerOpacity: layer.opacity,
            defaultLayerId: DEFAULT_LAYER_ID,
          })
        }
      }

      const cached = layerCacheRef.current.get(layer.id)
      if (cached?.ready) {
        const dx = (cached.cam.x - halfW * MARGIN - st.camera.x) * zoom * dpr + hw * dpr
        const dy = (cached.cam.y - halfH * MARGIN - st.camera.y) * zoom * dpr + hh * dpr
        ctx.drawImage(cached.canvas, dx, dy)
      }

      // 手势覆盖层插在该层之后，保证正确 z 序（绘制中/移动中的内容）
      if (gestureLayerIdRef.current === layer.id) {
        drawGestureOverlay(ctx, st.doc, itNow, w, h, zoom, st.camera, dpr)
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    dirtyLayersRef.current.clear()
    // 清理已删除层的缓存
    if (layerCacheRef.current.size > layers.length) {
      for (const id of [...layerCacheRef.current.keys()]) {
        if (!layers.some((l) => l.id === id)) layerCacheRef.current.delete(id)
      }
    }

    // 选区框画在合成结果之上
    ctx.save()
    ctx.translate(w / 2 - st.camera.x * zoom, h / 2 - st.camera.y * zoom)
    ctx.scale(zoom, zoom)
    if (st.selected.length) {
      const selBounds = getSelectionBounds(st.doc, st.selected, zoom)
      if (selBounds) {
        ctx.setLineDash([6 / zoom, 5 / zoom])
        ctx.strokeStyle = '#52525b'
        ctx.lineWidth = 1.5 / zoom
        ctx.strokeRect(selBounds.x0, selBounds.y0, selBounds.x1 - selBounds.x0, selBounds.y1 - selBounds.y0)

        const handleSize = 10 / zoom
        const hs = handleSize / 2
        const cx = (selBounds.x0 + selBounds.x1) / 2
        const cy = (selBounds.y0 + selBounds.y1) / 2
        const handlePts = [
          { x: selBounds.x0, y: selBounds.y0 },
          { x: cx, y: selBounds.y0 },
          { x: selBounds.x1, y: selBounds.y0 },
          { x: selBounds.x0, y: cy },
          { x: selBounds.x1, y: cy },
          { x: selBounds.x0, y: selBounds.y1 },
          { x: cx, y: selBounds.y1 },
          { x: selBounds.x1, y: selBounds.y1 },
        ]
        for (const hp of handlePts) {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(hp.x - hs, hp.y - hs, handleSize, handleSize)
          ctx.strokeStyle = '#52525b'
          ctx.lineWidth = 1.5 / zoom
          ctx.setLineDash([])
          ctx.strokeRect(hp.x - hs, hp.y - hs, handleSize, handleSize)
        }
      }
    }
    ctx.restore()

    if (st.tool === 'eraser' && hoverRef.current) {
      const r = eraserRadius(st.size) * zoom
      const sp = toScreen(hoverRef.current)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,0,0,0.04)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    for (const u of Object.values(st.users)) {
      if (u.id === st.selfId || !u.cursor) continue
      const disp = remoteCursorRef.current.get(u.id) ?? u.cursor
      const sp = toScreen(disp)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = u.color
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.font = '11px ui-sans-serif, sans-serif'
      const tw = ctx.measureText(u.name).width
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      roundRectPath(ctx, sp.x - tw / 2 - 5, sp.y - 26, tw + 10, 17, 4)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(u.name, sp.x - tw / 2, sp.y - 14)
    }
    recordDrawTime(performance.now() - drawStart)
  }, [toScreen, requestRaster])

  useEffect(() => {
    drawRef.current = draw
    draw()
  }, [draw])

  useEffect(() => {
    draw()
  }, [doc, camera, selected, users, draw])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const dpr = window.devicePixelRatio || 1
    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      viewportRef.current = { w: rect.width, h: rect.height }
      useStore.getState().setViewport({ w: rect.width, h: rect.height })
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      drawRef.current()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const st = useStore.getState()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const wx = (mx - rect.width / 2) / st.camera.zoom + st.camera.x
      const wy = (my - rect.height / 2) / st.camera.zoom + st.camera.y
      const zoom = clamp(st.camera.zoom * Math.exp(-e.deltaY * 0.0012), 0.15, 8)
      useStore.getState().setCamera({
        zoom,
        x: wx - (mx - rect.width / 2) / zoom,
        y: wy - (my - rect.height / 2) / zoom,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 渲染 Worker：负责层光栅化，主线程只做合成；不支持时回退到同步路径
  useEffect(() => {
    if (typeof Worker === 'undefined') {
      workerOkRef.current = false
      return
    }
    let w: Worker | null = null
    try {
      w = new Worker(new URL('../lib/render.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = w
      ;(window as unknown as Record<string, unknown>).__sharecanvasWorkerInfo = () => ({
        ok: workerOkRef.current,
      })
      w.onmessage = (e: MessageEvent) => {
        const msg = e.data as {
          type: string
          layerId?: string
          bitmap?: ImageBitmap
          width?: number
          height?: number
          zoom?: number
          camX?: number
          camY?: number
        }
        if (msg?.type === 'rasterized' && msg.layerId) {
          inflightRef.current.delete(msg.layerId)
          let cache = layerCacheRef.current.get(msg.layerId)
          // 缓存可能因隐藏层/重建被删除：ack 时重建，否则该层永远空白
          if (!cache) {
            cache = {
              canvas: document.createElement('canvas'),
              zoom: 0,
              cam: { x: 0, y: 0 },
              width: 0,
              height: 0,
              ready: false,
            }
            layerCacheRef.current.set(msg.layerId, cache)
          }
          if (msg.bitmap && msg.width && msg.height && msg.zoom !== undefined && msg.camX !== undefined && msg.camY !== undefined) {
            if (cache.canvas.width !== msg.width || cache.canvas.height !== msg.height) {
              cache.canvas.width = msg.width
              cache.canvas.height = msg.height
            }
            const octx = cache.canvas.getContext('2d')
            if (octx) {
              octx.setTransform(1, 0, 0, 1, 0, 0)
              octx.clearRect(0, 0, msg.width, msg.height)
              octx.drawImage(msg.bitmap, 0, 0)
            }
            msg.bitmap.close()
            cache.zoom = msg.zoom
            cache.cam = { x: msg.camX, y: msg.camY }
            cache.width = msg.width
            cache.height = msg.height
            cache.ready = true
          }
          if (pendingRasterRef.current.has(msg.layerId)) pumpRaster(msg.layerId)
          drawRef.current()
        } else if (msg?.type === 'unsupported' || msg?.type === 'error') {
          workerOkRef.current = false
          workerRef.current?.terminate()
          workerRef.current = null
          inflightRef.current.clear()
          pendingRasterRef.current.clear()
          drawRef.current()
        }
      }
      w.onerror = () => {
        workerOkRef.current = false
        workerRef.current?.terminate()
        workerRef.current = null
        drawRef.current()
      }
    } catch {
      workerOkRef.current = false
    }
    return () => {
      w?.terminate()
      workerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 远端光标平滑：存在远端光标时持续 rAF 推进显示位置并重绘
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const st = useStore.getState()
      const remote = Object.values(st.users).filter((u) => u.id !== st.selfId && u.cursor)
      if (!remote.length) {
        remoteCursorRef.current.clear()
        return
      }
      for (const u of remote) {
        const target = u.cursor as Pt
        const cur = remoteCursorRef.current.get(u.id)
        if (!cur) {
          remoteCursorRef.current.set(u.id, { x: target.x, y: target.y })
        } else {
          const k = 0.32
          cur.x += (target.x - cur.x) * k
          cur.y += (target.y - cur.y) * k
        }
      }
      drawRef.current()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const commitText = useCallback((reason?: 'blur') => {
    if (!textDraft) return
    const val = textValue.trim()
    if (reason === 'blur' && !val && Date.now() - textDraft.openedAt < 300) return
    const s = useStore.getState()
    const id = textDraft.id
    if (val) yUpdateItem('texts', id, { text: val })
    else yDeleteItems('texts', [id])
    if (val) s.select([id])
    setTextDraft(null)
    setTextValue('')
  }, [textDraft, textValue])

  const cancelText = useCallback(() => {
    if (!textDraft) return
    yDeleteItems('texts', [textDraft.id])
    setTextDraft(null)
    setTextValue('')
  }, [textDraft])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (e.key === ' ' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        spaceRef.current = true
        e.preventDefault()
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        useStore.getState().deleteSelected()
      }
      if (e.key === 'Escape' && textDraft) cancelText()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textDraft])

  // 输入框挂载后确保获得焦点（autoFocus 可能被浏览器默认行为覆盖）
  useEffect(() => {
    if (textDraft) textInputRef.current?.focus()
  }, [textDraft])

  const openText = useCallback(
    (w: Pt) => {
      if (textDraft) commitText()
      const s = useStore.getState()
      const id = createId('t')
      // 点中的是图形时，文字附着到图形中心
      const hit = hitShape(w, s.doc, s.camera.zoom)
      const world = hit ? shapeCenter(hit) : w
      const item: TextItem = {
        id,
        x: world.x,
        y: world.y,
        text: '',
        color: s.color,
        size: Math.max(14, s.size * 5),
        seq: nextSeq(),
        attachId: hit?.id,
        layer: hit?.layer ?? s.activeLayerId,
      }
      yPush('texts', [item])
      setTextDraft({ id, world, openedAt: Date.now() })
      setTextValue('')
    },
    [commitText, textDraft],
  )

  const editTextAt = useCallback(
    (id: string) => {
      if (textDraft) commitText()
      const s = useStore.getState()
      const t = s.doc.texts.find((x) => x.id === id)
      if (!t) return
      setTextDraft({ id, world: textWorldPos(t, s.doc), openedAt: Date.now() })
      setTextValue(t.text)
    },
    [commitText, textDraft],
  )

  const eraseAt = useCallback((w: Pt) => {
    const it = interactionRef.current
    if (it?.type !== 'erase') return

    // 节流：最多约 33 次/秒应用擦除，避免每帧都做全量计算
    const now = performance.now()
    if (now - it.last < 30) return
    it.last = now

    // 对移动轨迹按笔刷半径插值采样，快速移动也不会漏擦
    const centers: Pt[] = []
    const prev = it.path[it.path.length - 1]
    if (prev) {
      const dist = Math.hypot(w.x - prev.x, w.y - prev.y)
      const step = Math.max(2, it.r / 3)
      const n = Math.min(8, Math.ceil(dist / step))
      for (let i = 1; i <= n; i++) {
        centers.push({ x: prev.x + ((w.x - prev.x) * i) / n, y: prev.y + ((w.y - prev.y) * i) / n })
      }
    } else {
      centers.push(w)
    }

    // 区域颜色清除：记录圆形擦除遮罩，渲染时统一打洞
    const minD2 = (it.r * 0.2) ** 2
    const added: EraseCircle[] = []
    for (const c of centers) {
      const last = it.path[it.path.length - 1]
      if (last) {
        const dx = c.x - last.x
        const dy = c.y - last.y
        if (dx * dx + dy * dy < minD2) continue
      }
      it.path.push(c)
      if (it.path.length > 48) it.path = it.path.slice(-36)
      added.push({
        id: createId('e'),
        x: c.x,
        y: c.y,
        r: it.r,
        seq: nextSeq(),
        layer: useStore.getState().activeLayerId,
      })
    }
    if (added.length) {
      yPush('eraser', added)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 掌触拒绝：数位板笔正在使用时忽略触摸输入
    if (e.pointerType === 'touch' && [...pointersRef.current.values()].some((p) => p.type === 'pen')) {
      return
    }
    if (e.pointerType === 'pen') useStore.getState().setPenDetected(true)
    if (textDraft) commitText()
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType })
    const s = useStore.getState()
    if (e.button === 1 || e.button === 2 || spaceRef.current || s.tool === 'hand') {
      interactionRef.current = { type: 'pan', camStart: s.camera, start: { x: e.clientX, y: e.clientY } }
      return
    }
    const w = toWorld(e.clientX, e.clientY)
    // 活动层被隐藏/锁定时禁止绘制类工具（平移/选择不受限）
    const activeLayer = s.doc.layers.find((l) => l.id === s.activeLayerId)
    const canEdit = s.doc.layers.length === 0 || (!!activeLayer && activeLayer.visible && !activeLayer.locked)
    // 手型/平移在上面的分支已提前 return，这里只需排除选择工具
    if (s.tool !== 'select' && !canEdit) return
    if (s.tool === 'text') {
      // 阻止浏览器 mousedown 默认焦点行为，避免输入框刚挂载就被抢走焦点触发 blur
      e.preventDefault()
      openText(w)
      return
    }
    if (s.tool === 'pen' || s.tool === 'highlighter') {
      const isPen = e.pointerType === 'pen'
      const stroke: Stroke = {
        id: createId('s'),
        kind: s.tool === 'highlighter' ? 'highlighter' : s.brushStyle,
        points: [isPen ? { x: w.x, y: w.y, p: e.pressure || 0.5 } : w],
        color: s.color,
        size: s.tool === 'highlighter' ? Math.max(6, s.size * 1.6) : s.size,
        opacity: s.tool === 'highlighter' ? 0.35 : 1,
        seq: nextSeq(),
        layer: s.activeLayerId,
      }
      interactionRef.current = { type: 'stroke', stroke }
      suppressInvalidationRef.current = true
      gestureLayerIdRef.current = s.activeLayerId
      yPush('strokes', [{ ...stroke, points: stroke.points.slice() }])
      return
    }
    if (s.tool === 'eraser') {
      interactionRef.current = { type: 'erase', r: eraserRadius(s.size), path: [], last: 0 }
      eraseAt(w)
      return
    }
    if (
      s.tool === 'rect' ||
      s.tool === 'roundrect' ||
      s.tool === 'ellipse' ||
      s.tool === 'diamond' ||
      s.tool === 'parallelogram' ||
      s.tool === 'hexagon' ||
      s.tool === 'line' ||
      s.tool === 'arrow'
    ) {
      let attachStartId: string | undefined
      let start = w
      if (s.tool === 'arrow') {
        const hit = hitShape(w, s.doc, s.camera.zoom)
        if (hit) {
          attachStartId = hit.id
          start = shapeEdgePoint(hit, w)
        }
      }
      const shape: Shape = {
        id: createId('sh'),
        kind: s.tool,
        x0: start.x,
        y0: start.y,
        x1: w.x,
        y1: w.y,
        color: s.color,
        size: s.size,
        seq: nextSeq(),
        layer: s.activeLayerId,
        attachStartId,
      }
      interactionRef.current = { type: 'shape', id: shape.id, start: w, end: w }
      suppressInvalidationRef.current = true
      gestureLayerIdRef.current = s.activeLayerId
      yPush('shapes', [shape])
      return
    }
    if (s.tool === 'select') {
      const hit = hitTest(w, s.doc, s.camera.zoom)
      const selBounds = getSelectionBounds(s.doc, s.selected, s.camera.zoom)
      const resizeHandle = selBounds ? hitResizeHandle(w, selBounds, s.camera.zoom) : null

      if (resizeHandle && s.selected.length) {
        interactionRef.current = {
          type: 'resize',
          start: w,
          startBounds: { ...selBounds! },
          handle: resizeHandle,
        }
        gestureLayerIdRef.current = null
        suppressInvalidationRef.current = true
        return
      }

      if (!hit) {
        s.select([])
        interactionRef.current = { type: 'pan', camStart: s.camera, start: { x: e.clientX, y: e.clientY } }
        return
      }
      const items: ItemRef[] =
        s.selected.includes(hit.item.id)
          ? s.selected
              .map((id) => findItem(s.doc, id))
              .filter((x): x is ItemRef => x !== null)
          : [hit]
      if (!s.selected.includes(hit.item.id)) {
        s.select([hit.item.id])
      }
      interactionRef.current = { type: 'move', start: w, items, dx: 0, dy: 0 }
      // 手势层 = 参与移动元素所在的最底层
      const effLayer = (l?: string) =>
        l && s.doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID
      const layerIds = items.map((ref) => effLayer((ref.item as { layer?: string }).layer))
      const minIdx = Math.min(...layerIds.map((l) => s.doc.layers.findIndex((x) => x.id === l)))
      gestureLayerIdRef.current =
        minIdx >= 0 ? s.doc.layers[minIdx]?.id ?? s.activeLayerId : s.activeLayerId
      suppressInvalidationRef.current = true
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') useStore.getState().setPenDetected(true)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType })
    const w = toWorld(e.clientX, e.clientY)
    hoverRef.current = w
    collab.sendCursor(w.x, w.y)
    const s = useStore.getState()
    const it = interactionRef.current

    if (it?.type === 'pan') {
      const dx = e.clientX - it.start.x
      const dy = e.clientY - it.start.y
      s.setCamera({ x: it.camStart.x - dx / it.camStart.zoom, y: it.camStart.y - dy / it.camStart.zoom })
      return
    }

    if (pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()]
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (it?.type !== 'pinch') {
        interactionRef.current = { type: 'pinch', prevMid: mid, prevDist: dist, camStart: s.camera }
        return
      }
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const wx = (mid.x - rect.left - rect.width / 2) / s.camera.zoom + s.camera.x
      const wy = (mid.y - rect.top - rect.height / 2) / s.camera.zoom + s.camera.y
      const zoom = clamp(s.camera.zoom * (dist / Math.max(1, it.prevDist)), 0.15, 8)
      s.setCamera({
        zoom,
        x: wx - (mid.x - rect.left - rect.width / 2) / zoom,
        y: wy - (mid.y - rect.top - rect.height / 2) / zoom,
      })
      interactionRef.current = { type: 'pinch', prevMid: mid, prevDist: dist, camStart: s.camera }
      return
    }

    if (it?.type === 'stroke') {
      it.stroke.points.push(e.pointerType === 'pen' ? { ...w, p: e.pressure || 0.5 } : w)
      const pts = it.stroke.points.slice()
      yUpdateStrokePoints(it.stroke.id, pts)
      return
    }
    if (it?.type === 'shape') {
      it.end = w
      let attachEndId: string | undefined
      const cur = s.doc.shapes.find((x) => x.id === it.id)
      if (cur?.kind === 'arrow') {
        const hit = hitShape(w, s.doc, s.camera.zoom)
        attachEndId = hit && hit.id !== cur.attachStartId ? hit.id : undefined
      }
      yUpdateItem('shapes', it.id, { x1: w.x, y1: w.y, attachEndId })
      return
    }
    if (it?.type === 'erase') {
      eraseAt(w)
      return
    }
    if (it?.type === 'resize') {
      const dx = w.x - it.start.x
      const dy = w.y - it.start.y
      const b = it.startBounds
      const newBounds = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }
      const h = it.handle
      if (h.includes('e')) newBounds.x1 = b.x1 + dx
      if (h.includes('w')) newBounds.x0 = b.x0 + dx
      if (h.includes('s')) newBounds.y1 = b.y1 + dy
      if (h.includes('n')) newBounds.y0 = b.y0 + dy
      const scaleX = (newBounds.x1 - newBounds.x0) / (b.x1 - b.x0)
      const scaleY = (newBounds.y1 - newBounds.y0) / (b.y1 - b.y0)
      const offsetX = newBounds.x0 - b.x0
      const offsetY = newBounds.y0 - b.y0
      const items = s.selected.map((id) => findItem(s.doc, id)).filter((x): x is ItemRef => x !== null)
      for (const ref of items) {
        const item = ref.item
        if (ref.kind === 'shape') {
          const sh = item as Shape
          yUpdateItem('shapes', sh.id, {
            x0: sh.x0 * scaleX + offsetX,
            y0: sh.y0 * scaleY + offsetY,
            x1: sh.x1 * scaleX + offsetX,
            y1: sh.y1 * scaleY + offsetY,
          })
        } else if (ref.kind === 'text') {
          const ti = item as TextItem
          yUpdateItem('texts', ti.id, {
            x: ti.x * scaleX + offsetX,
            y: ti.y * scaleY + offsetY,
            size: Math.max(8, ti.size * Math.min(scaleX, scaleY)),
          })
        } else {
          const st = item as Stroke
          const pts = st.points.map((p) => ({
            ...p,
            x: p.x * scaleX + offsetX,
            y: p.y * scaleY + offsetY,
          }))
          yUpdateStrokePoints(st.id, pts)
          yUpdateItem('strokes', st.id, {
            size: Math.max(1, st.size * Math.min(scaleX, scaleY)),
          })
        }
      }
      return
    }
    if (it?.type === 'move') {
      const dx = w.x - it.start.x
      const dy = w.y - it.start.y
      it.dx = dx
      it.dy = dy
      for (const ref of it.items) {
        if (ref.kind === 'stroke') {
          const pts = (ref.item as Stroke).points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }))
          yUpdateStrokePoints(ref.item.id, pts)
        } else if (ref.kind === 'shape') {
          const sh = ref.item as Shape
          yUpdateItem('shapes', sh.id, {
            x0: sh.x0 + dx,
            y0: sh.y0 + dy,
            x1: sh.x1 + dx,
            y1: sh.y1 + dy,
          })
        } else {
          const ti = ref.item as TextItem
          yUpdateItem('texts', ti.id, { x: ti.x + dx, y: ti.y + dy })
        }
      }
      return
    }
    if (pointersRef.current.size === 0 || it === null) {
      drawRef.current()
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId)
    const it = interactionRef.current
    if (it?.type === 'stroke' || it?.type === 'shape' || it?.type === 'erase' || it?.type === 'move' || it?.type === 'resize') {
      if (it.type === 'shape') {
        if (Math.abs(it.end.x - it.start.x) < 3 && Math.abs(it.end.y - it.start.y) < 3) {
          yDeleteItems('shapes', [it.id])
        }
      }
      finishGesture()
    }
    if (pointersRef.current.size === 0) interactionRef.current = null
  }

  const onPointerCancel = () => {
    pointersRef.current.clear()
    finishGesture()
    interactionRef.current = null
  }

  // 手势结束：取消抑制、同步重光栅化涉及层，避免提交后闪烁
  const finishGesture = () => {
    const it = interactionRef.current
    suppressInvalidationRef.current = false
    gestureLayerIdRef.current = null
    if (it?.type === 'stroke' || it?.type === 'shape' || it?.type === 'move' || it?.type === 'resize') {
      const s = useStore.getState()
      const eff = (l?: string) => (l && s.doc.layers.some((x) => x.id === l) ? l : DEFAULT_LAYER_ID)
      const layerIds = new Set<string>()
      if (it.type === 'stroke') {
        layerIds.add(eff(it.stroke.layer))
      } else if (it.type === 'shape') {
        const sh = s.doc.shapes.find((x) => x.id === it.id)
        if (sh) layerIds.add(eff(sh.layer))
      } else if (it.type === 'move') {
        for (const ref of it.items) layerIds.add(eff((ref.item as { layer?: string }).layer))
      } else if (it.type === 'resize') {
        for (const id of s.selected) {
          const ref = findItem(s.doc, id)
          if (ref) layerIds.add(eff((ref.item as { layer?: string }).layer))
        }
      }
      for (const id of layerIds) {
        dirtyLayersRef.current.add(id)
        const opacity = s.doc.layers.find((l) => l.id === id)?.opacity ?? 1
        layerCacheRef.current.set(
          id,
          rasterizeLayerSync(
            layerCacheRef.current.get(id),
            s.doc,
            id,
            opacity,
            s.camera,
            s.camera.zoom,
            viewportRef.current.w,
            viewportRef.current.h,
            window.devicePixelRatio || 1,
            1.4,
          ),
        )
      }
      drawRef.current()
    }
  }

  // 双击：编辑自由文字，或编辑图形内附着的文字
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = useStore.getState()
    if (s.tool !== 'select') return
    const w = toWorld(e.clientX, e.clientY)
    const pad = 6 / s.camera.zoom
    for (let i = s.doc.texts.length - 1; i >= 0; i--) {
      const t = s.doc.texts[i]
      if (t.attachId) continue
      const b = itemBounds(t)
      if (w.x >= b.x0 - pad && w.x <= b.x1 + pad && w.y >= b.y0 - pad && w.y <= b.y1 + pad) {
        editTextAt(t.id)
        return
      }
    }
    const sh = hitShape(w, s.doc, s.camera.zoom)
    if (sh) {
      const attached = s.doc.texts.find((t) => t.attachId === sh.id)
      if (attached) editTextAt(attached.id)
    }
  }

  const cursor =
    tool === 'select'
      ? selected.length ? 'crosshair' : 'default'
      : tool === 'hand'
      ? 'grab'
      : tool === 'text'
        ? 'text'
        : tool === 'eraser'
          ? 'none'
          : tool === 'pen' || tool === 'highlighter'
            ? PEN_CURSOR
            : 'crosshair'

  const draftItem = textDraft ? doc.texts.find((t) => t.id === textDraft.id) : undefined
  const draftPos = textDraft
    // eslint-disable-next-line react-hooks/refs -- toScreen uses viewportRef for synchronous screen-space conversion
    ? toScreen(draftItem ? textWorldPos(draftItem, doc) : textDraft.world)
    : null
  const draftFontSize = Math.max(14, size * 5 * camera.zoom)

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-white">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onPointerLeave={() => {
          hoverRef.current = null
          drawRef.current()
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {textDraft && draftPos && (
        <input
          ref={textInputRef}
          autoFocus
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitText()
            if (e.key === 'Escape') cancelText()
          }}
          onBlur={() => commitText('blur')}
          className="absolute z-20 min-w-[80px] border-b border-zinc-900 bg-transparent text-zinc-900 outline-none"
          style={{
            left: draftPos.x,
            top: draftPos.y - draftFontSize * 0.9,
            fontSize: draftFontSize,
          }}
          placeholder="输入文字…"
        />
      )}
    </div>
  )
}
