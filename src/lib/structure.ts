// 结构识别阶段二：纯规则 detect_structure（表格 / 流程图 / 图表）
// 输入：画布上的图元列表（Shape），输出：结构类型 + 置信度 + 参与图元；
// beautifyStructure 返回对参与图元的修正补丁（对齐 / 吸附 / 规整）。
import type { Pt, Shape, ShapeKind } from '../types'
import { shapeEdgePoint } from './layerRender'

export type StructureType = 'flowchart' | 'barchart' | 'table'

export interface StructureResult {
  type: StructureType
  confidence: number
  /** 参与结构的图元 id（节点 + 连接线） */
  members: string[]
  info: Record<string, unknown>
}

export interface StructurePatch {
  id: string
  patch: Partial<Pick<Shape, 'x0' | 'y0' | 'x1' | 'y1' | 'kind' | 'attachStartId' | 'attachEndId'>>
}

const NODE_KINDS: ShapeKind[] = ['rect', 'roundrect', 'diamond']
const CELL_KINDS: ShapeKind[] = ['rect', 'roundrect']
const EDGE_KINDS: ShapeKind[] = ['arrow']

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function box(sh: Shape) {
  return {
    x0: Math.min(sh.x0, sh.x1),
    y0: Math.min(sh.y0, sh.y1),
    x1: Math.max(sh.x0, sh.x1),
    y1: Math.max(sh.y0, sh.y1),
  }
}

function center(sh: Shape): Pt {
  const b = box(sh)
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }
}

function dist(p: Pt, q: Pt) {
  return Math.hypot(p.x - q.x, p.y - q.y)
}

// 一维聚类：相邻差距 <= tol 归为一组
function cluster(values: number[], tol: number): number[][] {
  const sorted = [...values].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const v of sorted) {
    const g = groups[groups.length - 1]
    if (g && v - g[g.length - 1] <= tol) g.push(v)
    else groups.push([v])
  }
  return groups
}

/** 点是否落在图元包围盒（向外扩 pad）内 */
function inBox(sh: Shape, p: Pt, pad: number): boolean {
  const b = box(sh)
  return p.x >= b.x0 - pad && p.x <= b.x1 + pad && p.y >= b.y0 - pad && p.y <= b.y1 + pad
}

// ---------- 流程图 ----------
interface FlowNode {
  shape: Shape
  edges: FlowEdge[]
}

interface FlowEdge {
  arrow: Shape
  from: string
  to: string
}

function detectFlowchart(shapes: Shape[]): StructureResult | null {
  const nodes = shapes.filter((s) => NODE_KINDS.includes(s.kind))
  const arrows = shapes.filter((s) => EDGE_KINDS.includes(s.kind))
  if (nodes.length < 2 || arrows.length < 1) return null

  const byId = new Map(nodes.map((s) => [s.id, s]))
  const edges: FlowEdge[] = []

  for (const arrow of arrows) {
    const start = { x: arrow.x0, y: arrow.y0 }
    const end = { x: arrow.x1, y: arrow.y1 }
    const findNode = (p: Pt, exclude?: string): string | null => {
      // 优先使用已记录的 attach 关系
      if (exclude === 'start' && arrow.attachStartId && byId.has(arrow.attachStartId)) return arrow.attachStartId
      if (exclude === 'end' && arrow.attachEndId && byId.has(arrow.attachEndId)) return arrow.attachEndId
      let best: string | null = null
      let bestD = Infinity
      for (const n of nodes) {
        if (n.id === (exclude === 'start' ? arrow.attachStartId : arrow.attachEndId)) continue
        const b = box(n)
        const pad = Math.max(16, Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.25)
        const d = inBox(n, p, pad) ? dist(p, center(n)) : Infinity
        if (d < bestD) {
          bestD = d
          best = n.id
        }
      }
      return bestD === Infinity ? null : best
    }
    const from = findNode(start, 'start')
    const to = findNode(end, 'end')
    if (from && to && from !== to) edges.push({ arrow, from, to })
  }

  if (edges.length < 1) return null

  // 连通分量：节点通过箭头相连
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of edges) {
    adj.get(e.from)?.add(e.to)
    adj.get(e.to)?.add(e.from)
  }
  const visited = new Set<string>()
  let best: string[] = []
  for (const n of nodes) {
    if (visited.has(n.id)) continue
    const comp: string[] = []
    const queue = [n.id]
    visited.add(n.id)
    while (queue.length) {
      const id = queue.pop()!
      comp.push(id)
      for (const nb of adj.get(id) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb)
          queue.push(nb)
        }
      }
    }
    if (comp.length > best.length) best = comp
  }
  const compSet = new Set(best)
  const compEdges = edges.filter((e) => compSet.has(e.from) && compSet.has(e.to))
  if (best.length < 2 || compEdges.length < 1) return null

  return {
    type: 'flowchart',
    confidence: clamp(0.7 + 0.05 * (compEdges.length - 1), 0.7, 0.95),
    members: [...best, ...compEdges.map((e) => e.arrow.id)],
    info: {
      nodes: best.length,
      edges: compEdges.length,
      links: compEdges.map((e) => ({ arrow: e.arrow.id, from: e.from, to: e.to })),
    },
  }
}

// ---------- 柱状图 ----------
function detectBarchart(shapes: Shape[]): StructureResult | null {
  // 柱子可以是矩形，也可以是细竖线（手绘柱状图常见画法）
  const isVerticalLine = (s: Shape) => {
    const b = box(s)
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    return s.kind === 'line' && h >= 30 && w <= h * 0.25
  }
  const bars = shapes
    .filter((s) => CELL_KINDS.includes(s.kind) || isVerticalLine(s))
    .map((s) => ({ s, b: box(s) }))
  const barsOk = bars.filter(({ s, b }) => {
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    if (s.kind === 'line') return h >= 30 && w <= h * 0.25
    return w >= 8 && h >= 8
  })
  if (barsOk.length < 3) return null

  const widths = barsOk.map(({ b }) => b.x1 - b.x0)
  const bottoms = barsOk.map(({ b }) => b.y1)
  const med = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]!
  const medW = med(widths)
  // 底部对齐 + 等宽（相对容差，容忍手绘误差）
  const hSpread = (Math.max(...bottoms) - Math.min(...bottoms)) / Math.max(med(barsOk.map(({ b }) => b.y1 - b.y0)), 1)
  if (hSpread > 0.12) return null
  if (medW > 0) {
    const wSpread = (Math.max(...widths) - Math.min(...widths)) / medW
    if (wSpread > 0.45) return null
  }
  // 柱子中心不应重叠（左右排列）
  const cx = barsOk.map(({ b }) => (b.x0 + b.x1) / 2)
  for (let i = 0; i < cx.length; i++) {
    for (let j = i + 1; j < cx.length; j++) {
      if (Math.abs(cx[i]! - cx[j]!) < medW * 0.5) return null
    }
  }

  return {
    type: 'barchart',
    confidence: clamp(0.7 + 0.06 * (barsOk.length - 3), 0.7, 0.92),
    members: barsOk.map(({ s }) => s.id),
    info: { bars: barsOk.length },
  }
}

// ---------- 表格 ----------
function detectTable(shapes: Shape[]): StructureResult | null {
  const cells = shapes.filter((s) => CELL_KINDS.includes(s.kind)).map((s) => ({ s, b: box(s), c: center(s) }))
  if (cells.length < 3) return null

  const sizeMed = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]!
  const dim = sizeMed(cells.map(({ b }) => Math.max(b.x1 - b.x0, b.y1 - b.y0)))
  const tol = Math.max(12, dim * 0.25)

  const rowGroups = cluster(cells.map(({ c }) => c.y), tol)
  const colGroups = cluster(cells.map(({ c }) => c.x), tol)
  if (rowGroups.length < 2 || colGroups.length < 2) return null

  const rowY = rowGroups.map((g) => g.reduce((a, b) => a + b, 0) / g.length)
  const colX = colGroups.map((g) => g.reduce((a, b) => a + b, 0) / g.length)
  // 每个格子必须能唯一定位到某行某列
  const assign = (v: number, centers: number[]) => {
    const i = centers.findIndex((c) => Math.abs(v - c) <= tol * 1.5)
    return i >= 0 ? i : null
  }
  const gridInfo: { row: number; col: number; id: string }[] = []
  for (const cell of cells) {
    const r = assign(cell.c.y, rowY)
    const c = assign(cell.c.x, colX)
    if (r === null || c === null) return null
    if (gridInfo.some((g) => g.row === r && g.col === c)) return null // 同一格重复 → 不是规整网格
    gridInfo.push({ row: r, col: c, id: cell.s.id })
  }
  if (gridInfo.length !== cells.length || cells.length < 4) return null

  return {
    type: 'table',
    confidence: clamp(0.65 + 0.05 * (cells.length - 4), 0.65, 0.9),
    members: cells.map(({ s }) => s.id),
    info: { rows: rowY.length, cols: colX.length, grid: gridInfo },
  }
}

// ---------- 入口 ----------
export function detectStructure(shapes: Shape[]): StructureResult | null {
  return detectFlowchart(shapes) ?? detectBarchart(shapes) ?? detectTable(shapes)
}

/** 只保留与锚点图元（本次美化新产生的图元）空间相邻的图元，避免全画布误检 */
export function collectCandidates(shapes: Shape[], anchors: Shape[], margin: number): Shape[] {
  if (!anchors.length) return []
  let ax0 = Infinity
  let ay0 = Infinity
  let ax1 = -Infinity
  let ay1 = -Infinity
  for (const a of anchors) {
    const b = box(a)
    ax0 = Math.min(ax0, b.x0)
    ay0 = Math.min(ay0, b.y0)
    ax1 = Math.max(ax1, b.x1)
    ay1 = Math.max(ay1, b.y1)
  }
  return shapes.filter((s) => {
    const b = box(s)
    return b.x1 >= ax0 - margin && b.x0 <= ax1 + margin && b.y1 >= ay0 - margin && b.y0 <= ay1 + margin
  })
}

/**
 * 笔画空间聚类：相连（端点/边缘间距 <= gap）的笔画归为一组（多笔单图形），
 * 分离的笔画各自成组（柱状图/流程图等由多个图元组成的结构）。
 */
export function clusterStrokeGroups(
  strokes: { id: string; points: Pt[] }[],
  gap = 12,
): string[][] {
  if (strokes.length <= 1) return strokes.map((st) => [st.id])
  const boxes = strokes.map((st) => {
    const xs = st.points.map((p) => p.x)
    const ys = st.points.map((p) => p.y)
    return {
      id: st.id,
      b: {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      },
    }
  })
  const parent = new Map<string, string>(boxes.map((b) => [b.id, b.id]))
  const find = (a: string): string => {
    const p = parent.get(a)!
    if (p === a) return a
    const root = find(p)
    parent.set(a, root)
    return root
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!.b
      const b = boxes[j]!.b
      const distX = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
      const distY = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1))
      if (Math.hypot(distX, distY) <= gap) union(boxes[i]!.id, boxes[j]!.id)
    }
  }
  const groups = new Map<string, string[]>()
  for (const b of boxes) {
    const root = find(b.id)
    const g = groups.get(root) ?? []
    g.push(b.id)
    groups.set(root, g)
  }
  return [...groups.values()]
}

export function beautifyStructure(result: StructureResult, shapes: Shape[]): StructurePatch[] {
  const byId = new Map(shapes.map((s) => [s.id, s]))
  const patches: StructurePatch[] = []
  if (result.type === 'flowchart') {
    // 箭头端点吸附到节点边缘，并写入 attach 关系（渲染与 SVG 导出一致）
    const links = (result.info.links as { arrow: string; from: string; to: string }[] | undefined) ?? []
    for (const link of links) {
      const sh = byId.get(link.arrow)
      const startNode = byId.get(link.from)
      const endNode = byId.get(link.to)
      if (!startNode || !endNode) continue
      const startPt = shapeEdgePoint(startNode, center(endNode))
      const endPt = shapeEdgePoint(endNode, startPt)
      patches.push({
        id: link.arrow,
        patch: {
          x0: startPt.x,
          y0: startPt.y,
          x1: endPt.x,
          y1: endPt.y,
          attachStartId: startNode.id,
          attachEndId: endNode.id,
        },
      })
    }
  } else if (result.type === 'barchart') {
    const bars = result.members.map((id) => byId.get(id)!).filter(Boolean)
    const med = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]!
    const bottom = Math.max(...bars.map((s) => Math.max(s.y0, s.y1)))
    const width = med(bars.map((s) => Math.abs(s.x1 - s.x0)))
    const lineW = Math.max(16, Math.min(40, med(bars.map((s) => Math.abs(s.y1 - s.y0))) * 0.18))
    for (const s of bars) {
      const x0 = Math.min(s.x0, s.x1)
      const h = Math.abs(s.y1 - s.y0)
      // 细竖线柱子 → 转成等宽矩形柱
      if (s.kind === 'line' && width < 8) {
        const cx = (s.x0 + s.x1) / 2
        patches.push({
          id: s.id,
          patch: {
            kind: 'rect',
            x0: cx - lineW / 2,
            y0: bottom - h,
            x1: cx + lineW / 2,
            y1: bottom,
          },
        })
      } else {
        patches.push({ id: s.id, patch: { x0, y0: bottom - h, x1: x0 + width, y1: bottom } })
      }
    }
  } else if (result.type === 'table') {
    const cells = result.members.map((id) => byId.get(id)!).filter(Boolean)
    const grid = (result.info.grid as { row: number; col: number; id: string }[] | undefined) ?? []
    const med = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]!
    const cellW = med(cells.map((s) => Math.abs(s.x1 - s.x0)))
    const cellH = med(cells.map((s) => Math.abs(s.y1 - s.y0)))
    const minX = Math.min(...cells.map((s) => Math.min(s.x0, s.x1)))
    const minY = Math.min(...cells.map((s) => Math.min(s.y0, s.y1)))
    for (const g of grid) {
      const s = byId.get(g.id)
      if (!s) continue
      patches.push({
        id: g.id,
        patch: {
          x0: minX + g.col * cellW,
          y0: minY + g.row * cellH,
          x1: minX + (g.col + 1) * cellW,
          y1: minY + (g.row + 1) * cellH,
        },
      })
    }
  }
  return patches
}
