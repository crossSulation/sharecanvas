import { describe, it, expect } from 'vitest'
import { beautifyStructure, clusterStrokeGroups, collectCandidates, detectStructure } from './structure'
import type { Shape } from '../types'

const sh = (id: string, kind: Shape['kind'], x0: number, y0: number, x1: number, y1: number): Shape => ({
  id,
  kind,
  x0,
  y0,
  x1,
  y1,
  color: '#18181b',
  size: 4,
})

describe('detectStructure / beautifyStructure', () => {
  it('柱状图：底部对齐且等宽的 3 个矩形被识别并统一底部与宽度', () => {
    const shapes = [
      sh('b1', 'rect', 100, 100, 130, 200),
      sh('b2', 'rect', 150, 120, 180, 200),
      sh('b3', 'rect', 200, 130, 230, 200),
    ]
    const r = detectStructure(shapes)
    expect(r?.type).toBe('barchart')
    expect(r?.members).toHaveLength(3)

    const patches = beautifyStructure(r!, shapes)
    const patched = new Map(patches.map((p) => [p.id, { ...shapes.find((s) => s.id === p.id)!, ...p.patch }]))
    const bottoms = [...patched.values()].map((s) => s.y1)
    const widths = [...patched.values()].map((s) => Math.abs(s.x1 - s.x0))
    expect(new Set(bottoms).size).toBe(1)
    expect(new Set(widths).size).toBe(1)
    expect(patched.get('b1')?.y0).toBeLessThan(patched.get('b1')!.y1!)
  })

  it('柱状图：底部不对齐的矩形不识别为柱状图', () => {
    const shapes = [
      sh('a1', 'rect', 100, 100, 130, 200),
      sh('a2', 'rect', 150, 120, 180, 300),
      sh('a3', 'rect', 200, 130, 230, 400),
    ]
    expect(detectStructure(shapes)?.type).not.toBe('barchart')
  })

  it('柱状图：细竖线柱子被识别，美化后转成等宽矩形柱', () => {
    const shapes = [
      sh('l1', 'line', 100, 100, 103, 200),
      sh('l2', 'line', 150, 120, 153, 200),
      sh('l3', 'line', 200, 130, 203, 200),
    ]
    const r = detectStructure(shapes)
    expect(r?.type).toBe('barchart')
    const patches = beautifyStructure(r!, shapes)
    const patched = new Map(patches.map((p) => [p.id, { ...shapes.find((s) => s.id === p.id)!, ...p.patch }]))
    expect([...patched.values()].every((s) => s.kind === 'rect')).toBe(true)
    const bottoms = [...patched.values()].map((s) => s.y1)
    const widths = [...patched.values()].map((s) => Math.abs(s.x1 - s.x0))
    expect(new Set(bottoms).size).toBe(1)
    expect(new Set(widths).size).toBe(1)
  })

  it('表格：2x2 网格被识别，美化后吸附为等宽等高的规整网格', () => {
    const shapes = [
      sh('c1', 'rect', 100, 100, 160, 150),
      sh('c2', 'roundrect', 175, 102, 235, 152),
      sh('c3', 'rect', 102, 162, 162, 212),
      sh('c4', 'rect', 173, 160, 233, 210),
    ]
    const r = detectStructure(shapes)
    expect(r?.type).toBe('table')
    expect(r?.info).toMatchObject({ rows: 2, cols: 2 })

    const patches = beautifyStructure(r!, shapes)
    const patched = new Map(patches.map((p) => [p.id, { ...shapes.find((s) => s.id === p.id)!, ...p.patch }]))
    const xs = [...patched.values()].map((s) => s.x0)
    const widths = [...patched.values()].map((s) => Math.abs(s.x1 - s.x0))
    const heights = [...patched.values()].map((s) => Math.abs(s.y1 - s.y0))
    expect(new Set(widths).size).toBe(1)
    expect(new Set(heights).size).toBe(1)
    // 4 个格子应占用 2x2 网格的 4 个不同起始点
    expect(new Set(xs).size).toBe(2)
  })

  it('流程图：两个节点 + 一条箭头被识别，美化后箭头吸附到节点边缘', () => {
    const shapes = [
      sh('n1', 'rect', 100, 100, 200, 150),
      sh('n2', 'diamond', 300, 100, 400, 150),
      sh('e1', 'arrow', 200, 125, 300, 125),
    ]
    const r = detectStructure(shapes)
    expect(r?.type).toBe('flowchart')
    expect(r?.members).toContain('e1')

    const patches = beautifyStructure(r!, shapes)
    const e = patches.find((p) => p.id === 'e1')
    expect(e?.patch.attachStartId).toBe('n1')
    expect(e?.patch.attachEndId).toBe('n2')
    // 端点应落在节点边缘（x0=200 是 n1 右边缘，x1=300 是 n2 左边缘）
    expect(e?.patch.x0).toBeCloseTo(200, 5)
    expect(e?.patch.x1).toBeCloseTo(300, 5)
  })

  it('零散矩形不识别为任何结构', () => {
    const shapes = [
      sh('r1', 'rect', 100, 100, 160, 200),
      sh('r2', 'rect', 400, 300, 460, 380),
      sh('r3', 'rect', 700, 100, 760, 150),
    ]
    expect(detectStructure(shapes)).toBeNull()
  })

  it('collectCandidates 只保留锚点附近的图元', () => {
    const shapes = [
      sh('near1', 'rect', 100, 100, 160, 200),
      sh('near2', 'rect', 180, 105, 240, 200),
      sh('far', 'rect', 900, 900, 960, 950),
    ]
    const anchors = [shapes[0]!]
    const got = collectCandidates(shapes, anchors, 80).map((s) => s.id)
    expect(got).toContain('near1')
    expect(got).toContain('near2')
    expect(got).not.toContain('far')
  })

  it('clusterStrokeGroups：分离的笔画各自成组，端点相接的笔画合并', () => {
    const strokes = [
      { id: 'bar1', points: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 0 }, { x: 0, y: 0 }] },
      { id: 'bar2', points: [{ x: 80, y: 0 }, { x: 80, y: 100 }, { x: 130, y: 100 }, { x: 130, y: 0 }, { x: 80, y: 0 }] },
      { id: 'tri1', points: [{ x: 300, y: 0 }, { x: 400, y: 100 }] },
      { id: 'tri2', points: [{ x: 400, y: 100 }, { x: 300, y: 100 }] },
      { id: 'tri3', points: [{ x: 300, y: 100 }, { x: 300, y: 0 }] },
    ]
    const groups = clusterStrokeGroups(strokes).map((g) => g.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!))
    expect(groups).toEqual([
      ['bar1'],
      ['bar2'],
      ['tri1', 'tri2', 'tri3'],
    ])
  })
})
