import { smoothPoints, detectShape } from './aiDraw'
import { useStore } from '../store'
import { yDeleteItems, yPush, yUpdateItem, yUpdateStrokePoints } from './yroom'
import { createId } from './id'
import { nextSeq } from './seq'
import type { Pt, Stroke } from '../types'
import {
  beautifyStructure,
  clusterStrokeGroups,
  collectCandidates,
  detectStructure,
  type StructureResult,
} from './structure'

// Tauri WebView 改写 origin 为 tauri.localhost，fetch 相对路径失效，需使用本机数据服务地址
const AI_BASE = import.meta.env.LOCAL_DATA_URL ?? ''

// 小于该尺寸的笔画视为手写文字/数字（如 0-9），只平滑、不转形状
// 书写区域大小路由：小于该尺寸视为手写数字（转文字），否则走形状识别
const HANDWRITING_MAX_SIZE = 120

// 模型返回的数字类别（与 crates/ai-core/src/onnx.rs 的 labels 后 10 类一致）
const DIGIT_KINDS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

let debugSeq = 0
// 移动端调试日志：同时打到 console 和 Rust 端日志文件（fire-and-forget，不阻塞流程）
function mobileLog(...args: unknown[]) {
  const line = `[beautify:${++debugSeq}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  console.log(line)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__
  if (internals && typeof internals.invoke === 'function') {
    try {
      void Promise.resolve(internals.invoke('debug_log', { msg: line })).catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

interface BackendAI {
  beautify_stroke(args: { strokes: { x: number; y: number }[][] }): Promise<{
    points: { x: number; y: number }[]
    detectedShape: { kind: string; x0: number; y0: number; x1: number; y1: number; confidence: number } | null
  }>
}

type BackendName = 'tauri' | 'native-server' | 'js-fallback'

export async function showLogPath() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasTauri = !!(window as any).__TAURI_INTERNALS__
  if (hasTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const path = await invoke<string>('log_file_path')
      console.log('%c[AI] log file (tauri): %c%s', 'color:#a1a1aa', 'color:#3b82f6', path || '(empty — path not set)')
    } catch (e) {
      console.log('%c[AI] tauri log path error: %c%s', 'color:#a1a1aa', 'color:#f87171', String(e))
    }
    return
  }

  try {
    const res = await fetch(`${AI_BASE}/api/ai/log-path`)
    const { path } = await res.json()
    console.log('%c[AI] log file (server): %c%s', 'color:#a1a1aa', 'color:#22c55e', path || '(empty)')
  } catch {
    console.log('%c[AI] log: %crunning in browser, no file log', 'color:#a1a1aa', 'color:#a1a1aa')
  }
}

// 优先直接走 __TAURI_INTERNALS__.invoke（移动端 WebView 实测可用），
// 失败时回退到 @tauri-apps/api/core 的 invoke
function makeTauriBackend(): BackendAI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__
  return {
    beautify_stroke: (args) => {
      if (internals && typeof internals.invoke === 'function') {
        try {
          return Promise.resolve(internals.invoke('beautify_stroke', args))
        } catch (e) {
          console.log('[beautify] internals.invoke threw:', String(e))
        }
      }
      return import('@tauri-apps/api/core').then((m) => m.invoke('beautify_stroke', args))
    },
  }
}

let backendCacheAt = 0
let backendCache: Promise<{ backend: BackendAI; name: BackendName } | null> | null = null

// 后端探测结果做缓存（失败 30s 后重试），避免每次美化都重复探测——
// 局域网地址不可达时，每次探测都会拖慢 ~2s，导致识别结果迟迟不出现
function getBackend(): Promise<{ backend: BackendAI; name: BackendName } | null> {
  const now = Date.now()
  if (!backendCache || now - backendCacheAt > 30000) {
    backendCacheAt = now
    backendCache = resolveBackend()
  }
  return backendCache
}

async function resolveBackend(): Promise<{ backend: BackendAI; name: BackendName } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      return { backend: makeTauriBackend(), name: 'tauri' }
    } catch {
      /* Tauri API not available */
    }
  }

  if (typeof fetch !== 'undefined') {
    try {
      const res = await withTimeout(
        fetch(`${AI_BASE}/api/ai/beautify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: [] }),
        }),
        800,
        'ai-probe',
      )
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        return {
          name: 'native-server',
          backend: {
            beautify_stroke: async (args) => {
              const r = await fetch(`${AI_BASE}/api/ai/beautify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
              })
              return r.json()
            },
          },
        }
      }
    } catch {
      /* server AI not reachable */
    }
  }

  return null
}

function extractPoints(points: unknown[]): Pt[] {
  return points.map((p) => {
    if (typeof p === 'object' && p !== null && 'x' in p && 'y' in p) {
      return { x: Number((p as { x: number }).x), y: Number((p as { y: number }).y) }
    }
    return { x: 0, y: 0 }
  }).filter((p) => isFinite(p.x) && isFinite(p.y))
}

function regeneratePoints(shape: { kind: string; x0: number; x1: number; funcParams?: number[] }): Pt[] {
  const params = shape.funcParams
  if (!params) return []
  const n = 100
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const x = shape.x0 + t * (shape.x1 - shape.x0)
    let y: number
    if (shape.kind === 'linear' && params.length >= 2) {
      y = params[0]! * x + params[1]!
    } else if (shape.kind === 'quadratic' && params.length >= 3) {
      y = params[0]! * x * x + params[1]! * x + params[2]!
    } else {
      return []
    }
    pts.push({ x, y })
  }
  return pts
}

function handleDetected(id: string, detected: { kind: string; x0: number; y0: number; x1: number; y1: number; funcParams?: number[] }, strokeColor: string, strokeSize: number, strokeLayer?: string) {
  const isFunc = (detected.kind === 'linear' || detected.kind === 'quadratic') && detected.funcParams
  if (isFunc) {
    const newPts = regeneratePoints(detected)
    if (newPts.length > 0) {
      yUpdateStrokePoints(id, newPts)
      return 'func'
    }
  }
  if (DIGIT_KINDS.has(detected.kind)) {
    // 数字 → 渲染为文字
    const cx = (detected.x0 + detected.x1) / 2
    const cy = (detected.y0 + detected.y1) / 2
    const h = Math.abs(detected.y1 - detected.y0)
    const fontSize = Math.max(12, Math.round(h))
    yDeleteItems('strokes', [id])
    yPush('texts', [{
      id: createId('t'),
      x: cx,
      y: cy + fontSize * 0.35,
      text: detected.kind,
      color: strokeColor,
      size: fontSize,
      seq: nextSeq(),
      layer: strokeLayer,
    }])
    return 'text'
  }
  yDeleteItems('strokes', [id])
  yPush('shapes', [{
    id: createId('sh'),
    kind: detected.kind,
    x0: detected.x0, y0: detected.y0,
    x1: detected.x1, y1: detected.y1,
    color: strokeColor,
    size: strokeSize,
    seq: nextSeq(),
    layer: strokeLayer,
  }])
  return 'shape'
}

export async function beautifySelected(
  smoothOnly = false,
): Promise<{ count: number; structure: StructureResult | null }> {
  const t0 = performance.now()
  const s0 = useStore.getState()
  const initialShapeIds = new Set(s0.doc.shapes.map((sh) => sh.id))
  const strokeIds = s0.selected.filter((id) => s0.doc.strokes.some((st) => st.id === id))
  mobileLog('selected=', s0.selected.length, 'strokeIds=', strokeIds.length)
  if (!strokeIds.length) {
    mobileLog('no stroke selected, abort')
    return { count: 0, structure: null }
  }

  const resolved = await getBackend()
  const backend = resolved?.backend ?? null
  const pathLabel = resolved?.name ?? 'js-fallback'
  mobileLog('backend=', pathLabel)

  // 空间聚类：相连（端点相接）的笔画合并识别（多笔单图形），
  // 分离的笔画各自美化（柱状图/流程图等多图元结构）
  const strokes = strokeIds
    .map((id) => s0.doc.strokes.find((st) => st.id === id))
    .filter((st): st is Stroke => !!st)
  const groups = clusterStrokeGroups(strokes)
  mobileLog('groups=', groups.length)

  let count = 0
  let shapeCount = 0
  for (const group of groups) {
    const r = await beautifyStrokeGroup(group, smoothOnly, backend, pathLabel)
    count += r.count
    shapeCount += r.shapeCount
  }

  const totalMs = (performance.now() - t0).toFixed(1)
  console.log(
    `%c[beautify] %cdone %c${totalMs}ms %cshapes=${shapeCount} smoothed=${count - shapeCount}`,
    'color:#8b5cf6;font-weight:bold', '', 'color:#a1a1aa', '', '',
  )

  // 结构识别（阶段二）：本次美化产生了图元后，检查它们是否与已有图元组成结构
  let structure: StructureResult | null = null
  if (!smoothOnly && shapeCount > 0) {
    const fresh = useStore.getState().doc
    const newShapeIds = new Set(fresh.shapes.filter((sh) => !initialShapeIds.has(sh.id)).map((sh) => sh.id))
    const newShapes = fresh.shapes.filter((sh) => newShapeIds.has(sh.id))
    // 只看新图元附近的图元，避免画布上无关的旧图形干扰结构判断
    const candidates = collectCandidates(fresh.shapes, newShapes, 140)
    const detected = detectStructure(candidates)
    if (detected && detected.members.some((id) => newShapeIds.has(id))) {
      const patches = beautifyStructure(detected, fresh.shapes)
      for (const p of patches) yUpdateItem('shapes', p.id, p.patch)
      structure = detected
      mobileLog(
        'structure=',
        detected.type,
        'conf=',
        detected.confidence.toFixed(2),
        'members=',
        detected.members.length,
        'patches=',
        patches.length,
      )
    }
  }

  return { count, structure }
}

// 美化一组笔画（同一图形）：收集点 → 后端/纯算法识别 → 转形状或平滑
async function beautifyStrokeGroup(
  strokeIds: string[],
  smoothOnly: boolean,
  backend: { beautify_stroke(args: { strokes: { x: number; y: number }[][] }): Promise<{ points: { x: number; y: number }[]; detectedShape: { kind: string; confidence: number } | null }> } | null,
  pathLabel: string,
): Promise<{ count: number; shapeCount: number }> {
  const s = useStore.getState()
  const allPts: Pt[] = []
  const strokePts: Pt[][] = []
  const firstStroke = s.doc.strokes.find((st) => st.id === strokeIds[0])
  const refColor = firstStroke?.color ?? '#18181b'
  const refSize = firstStroke?.size ?? 4
  const refLayer = firstStroke?.layer
  for (const id of strokeIds) {
    const st = s.doc.strokes.find((x) => x.id === id)
    if (!st || st.points.length < 2) continue
    const pts = extractPoints(st.points)
    strokePts.push(pts)
    for (const p of pts) allPts.push(p)
  }
  if (allPts.length < 4) {
    // 点太少，逐个平滑即可
    for (const id of strokeIds) {
      const st = s.doc.strokes.find((x) => x.id === id)
      if (!st || st.points.length < 3) continue
      const pts = extractPoints(st.points)
      if (pts.length < 3) continue
      yUpdateStrokePoints(id, smoothPoints(pts, 2))
    }
    return { count: strokeIds.length, shapeCount: 0 }
  }

  console.log(
    `%c[beautify] %cpath=%c${pathLabel} %cstrokes=%c${strokeIds.length} %crefined into %c${allPts.length} points`,
    'color:#8b5cf6;font-weight:bold', '', 'color:#3b82f6', '', 'color:#18181b;font-weight:bold', '', 'color:#18181b',
  )

  const xs = allPts.map((p) => p.x)
  const ys = allPts.map((p) => p.y)
  const bboxW = Math.max(...xs) - Math.min(...xs)
  const bboxH = Math.max(...ys) - Math.min(...ys)
  // 1-2 笔且尺寸很小 → 大概率是手写数字/文字，避免被识别成随机形状
  // 尺寸按屏幕像素比较（世界尺寸 × 缩放），缩放画布后手写区域路由保持一致
  const zoom = useStore.getState().camera.zoom
  const screenSize = Math.max(bboxW, bboxH) * zoom
  const textLike = !smoothOnly && strokeIds.length <= 2 && screenSize < HANDWRITING_MAX_SIZE
  if (textLike) mobileLog('small handwriting (size=', Math.round(screenSize), ') -> digit/text path')
  if (smoothOnly) mobileLog('smooth-only mode -> skip shape recognition')

  const t1 = performance.now()
  let smoothedCount = 0
  let shapeCount = 0

  let backendResult: { points: Pt[]; detectedShape: { kind: string; confidence: number } | null } | null = null
  if (backend) {
    mobileLog('invoke begin', 'strokes=' + strokePts.length, 'pts=' + allPts.length)
    try {
      backendResult = await withTimeout(
        backend.beautify_stroke({ strokes: strokePts }),
        20000,
        'beautify_stroke',
      )
      mobileLog('invoke ok in', Math.round(performance.now() - t1) + 'ms', 'kind=' + (backendResult.detectedShape?.kind ?? 'null'))
    } catch (e) {
      mobileLog('invoke fail:', String(e))
    }
  }

  if (backendResult) {
    const result = backendResult
    const rawDetected = result.detectedShape as { kind: string; x0: number; y0: number; x1: number; y1: number; confidence: number; funcParams?: number[] } | null
    let detected = smoothOnly ? null : rawDetected
    console.log(
      '[beautify] result: detected=',
      rawDetected
        ? `${rawDetected.kind} conf=${rawDetected.confidence.toFixed(3)}`
        : 'null',
      'pts=', result.points?.length,
    )
    const smoothed = result.points as Pt[]

    if (detected && detected.confidence > 0.5 && allPts.length > 10) {
      const isDigit = DIGIT_KINDS.has(detected.kind)
      // 路由：小书写区域 → 只接受数字（转文字）；大区域 → 只接受形状
      const accept = textLike ? isDigit : !isDigit
      if (!accept) {
        console.log('[beautify] rejected mismatched kind (small=', textLike, 'kind=', detected.kind, ') -> smooth')
        detected = null
      }
    }

    if (detected && detected.confidence > 0.5 && allPts.length > 10) {
      console.log('[beautify] accept shape:', detected.kind, 'conf=', detected.confidence.toFixed(3))
      const outcome = handleDetected(strokeIds[0]!, detected, refColor, refSize, refLayer)
      // 删除其他笔画
      if (strokeIds.length > 1) yDeleteItems('strokes', strokeIds.slice(1))
      console.log(
        `  %c→ ${outcome} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
        outcome === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
      )
      if (outcome === 'func') smoothedCount++
      else shapeCount++
    } else {
      console.log('[beautify] no shape accepted (detected=', detected?.kind ?? 'null', 'conf=', detected?.confidence?.toFixed(3) ?? '-', 'allPts=', allPts.length, ') -> smooth')
      // 未识别为形状 → 平滑合并点，更新到第一笔，删除其余
      // 按原始笔画顺序分配平滑点
      let offset = 0
      for (const id of strokeIds) {
        const st = s.doc.strokes.find((x) => x.id === id)
        if (!st) continue
        const origLen = st.points.length
        if (origLen < 2) continue
        // 平滑后的对应段
        const tStart = offset / Math.max(allPts.length - 1, 1)
        const tEnd = (offset + origLen - 1) / Math.max(allPts.length - 1, 1)
        const segPts: Pt[] = []
        const segN = Math.max(origLen, 3)
        for (let i = 0; i < segN; i++) {
          const si = Math.round(tStart * (smoothed.length - 1) + i * (tEnd - tStart) * (smoothed.length - 1) / Math.max(segN - 1, 1))
          if (si >= 0 && si < smoothed.length) segPts.push(smoothed[si]!)
        }
        yUpdateStrokePoints(id, segPts.length >= 2 ? segPts : smoothed)
        smoothedCount++
        offset += origLen
      }
    }
  } else {
    const smoothed = smoothPoints(allPts, 2)
    const detected = detectShape(smoothed)

    if (detected && !smoothOnly && !textLike && detected.confidence > 0.5 && allPts.length > 10) {
      const outcome = handleDetected(strokeIds[0]!, detected, refColor, refSize, refLayer)
      if (strokeIds.length > 1) yDeleteItems('strokes', strokeIds.slice(1))
      console.log(
        `  %c→ ${outcome} %c${detected.kind} %cconf=${(detected.confidence * 100).toFixed(0)}% %c${(performance.now() - t1).toFixed(1)}ms`,
        outcome === 'func' ? 'color:#3b82f6' : 'color:#22c55e', 'color:#18181b;font-weight:bold', 'color:#a1a1aa', 'color:#a1a1aa',
      )
      if (outcome === 'func') smoothedCount++
      else shapeCount++
    } else {
      // 未识别 → 平滑各段
      let offset = 0
      for (const id of strokeIds) {
        const st = s.doc.strokes.find((x) => x.id === id)
        if (!st) continue
        const origLen = st.points.length
        if (origLen < 2) continue
        const tStart = offset / Math.max(allPts.length - 1, 1)
        const tEnd = (offset + origLen - 1) / Math.max(allPts.length - 1, 1)
        const segPts: Pt[] = []
        const segN = Math.max(origLen, 3)
        for (let i = 0; i < segN; i++) {
          const si = Math.round(tStart * (smoothed.length - 1) + i * (tEnd - tStart) * (smoothed.length - 1) / Math.max(segN - 1, 1))
          if (si >= 0 && si < smoothed.length) segPts.push(smoothed[si]!)
        }
        yUpdateStrokePoints(id, segPts.length >= 2 ? segPts : smoothed)
        smoothedCount++
        offset += origLen
      }
    }
  }

  return { count: strokeIds.length, shapeCount }
}
