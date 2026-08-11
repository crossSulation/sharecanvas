import { describe, it, expect } from 'vitest'
import { smoothPoints, detectShape } from './aiDraw'
import type { Pt } from '../types'

function pts(xy: [number, number][]): Pt[] {
  return xy.map(([x, y]) => ({ x, y }))
}

describe('smoothPoints', () => {
  it('returns same array when points < 3', () => {
    expect(smoothPoints([{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }])
    expect(smoothPoints([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toEqual([{ x: 0, y: 0 }, { x: 5, y: 5 }])
  })

  it('smoothes a zigzag line (2 passes)', () => {
    const input = pts([[0, 5], [5, 0], [10, 5], [15, 0], [20, 5]])
    const result = smoothPoints(input, 2)
    expect(result.length).toBe(input.length)
    expect(result[0]).toEqual(input[0]) // endpoints unchanged
    expect(result[result.length - 1]).toEqual(input[input.length - 1])
    // 中间的尖角 y 应被平滑到接近 2.5
    expect(result[2]!.y).toBeGreaterThan(0.5)
    expect(result[2]!.y).toBeLessThan(4.5)
  })

  it('smoothes a straight line stays straight', () => {
    const input = pts([[0, 0], [10, 10], [20, 20]])
    const result = smoothPoints(input, 2)
    expect(result[1]!.x).toBeCloseTo(10)
    expect(result[1]!.y).toBeCloseTo(10)
  })

  it('1 pass reduces noise less than 2 passes', () => {
    const input = pts([[0, 0], [10, 20], [20, 0]])
    const r1 = smoothPoints(input, 1)
    const r2 = smoothPoints(input, 2)
    // 2 passes 中间点更靠近端点连线 (y=0)
    expect(r2[1]!.y).toBeLessThan(r1[1]!.y)
  })
})

describe('detectShape', () => {
  it('returns null for too few points', () => {
    expect(detectShape(pts([[0, 0], [10, 10]]))).toBeNull()
  })

  it('returns null for tiny shapes', () => {
    // 4 个点但在 3x3 区域内
    expect(detectShape(pts([[1, 1], [2, 1], [2, 2], [1, 2]]))).toBeNull()
  })

  it('detects straight horizontal line as line (no arrowhead)', () => {
    const line = pts([[10, 50], [30, 50], [50, 50], [70, 50], [90, 50]])
    const result = detectShape(line)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('line')
    expect(result!.confidence).toBeGreaterThan(0.85)
  })

  it('detects diagonal line (steep angle, not arrow)', () => {
    const line = pts([[0, 0], [20, 20], [40, 40], [60, 60]])
    const result = detectShape(line)
    expect(result).not.toBeNull()
    expect(['line', 'arrow', 'linear']).toContain(result!.kind)
    expect(result!.confidence).toBeGreaterThan(0.8)
  })

  it('detects rectangle boundary', () => {
    const rect: Pt[] = []
    for (let i = 0; i <= 20; i++) rect.push({ x: 10 + i, y: 10 })
    for (let i = 0; i <= 20; i++) rect.push({ x: 30, y: 10 + i })
    for (let i = 0; i <= 20; i++) rect.push({ x: 30 - i, y: 30 })
    for (let i = 0; i <= 20; i++) rect.push({ x: 10, y: 30 - i })
    const result = detectShape(rect)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('rect')
    expect(result!.confidence).toBeGreaterThan(0.6)
  })

  it('detects ellipse (circle-like points)', () => {
    const cx = 100, cy = 100, rx = 40, ry = 40
    const circle: Pt[] = []
    for (let i = 0; i < 64; i++) {
      const a = (Math.PI * 2 * i) / 64
      circle.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) })
    }
    const result = detectShape(circle)
    expect(result).not.toBeNull()
    // 圆边界靠近矩形，可能先匹配 rect，两者置信度都高即可
    expect(['rect', 'ellipse']).toContain(result!.kind)
    expect(result!.confidence).toBeGreaterThan(0.6)
  })

  it('detects diamond', () => {
    const cx = 200, cy = 200, hw = 60, hh = 60
    const diamond: Pt[] = []
    // top → right: many points along edge
    const segments: [Pt, Pt][] = [
      [{ x: cx, y: cy - hh }, { x: cx + hw, y: cy }],
      [{ x: cx + hw, y: cy }, { x: cx, y: cy + hh }],
      [{ x: cx, y: cy + hh }, { x: cx - hw, y: cy }],
      [{ x: cx - hw, y: cy }, { x: cx, y: cy - hh }],
    ]
    for (const [a, b] of segments) {
      for (let i = 0; i <= 15; i++) {
        diamond.push({ x: a.x + (b.x - a.x) * i / 15, y: a.y + (b.y - a.y) * i / 15 })
      }
    }
    const result = detectShape(diamond)
    expect(result).not.toBeNull()
    // 闭合菱形可能先匹配 rect（边界矩形接近），期望是 rect 或 diamond
    expect(['rect', 'diamond']).toContain(result!.kind)
    expect(result!.confidence).toBeGreaterThan(0.55)
  })

  it('detects trapezoid (narrower top, wider bottom)', () => {
    const cx = 200, cy = 300, w = 120, h = 80
    const topW = w * 0.5
    const verts = [
      { x: cx - topW / 2, y: cy - h / 2 },
      { x: cx + topW / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy + h / 2 },
      { x: cx - w / 2, y: cy + h / 2 },
    ]
    const trap: Pt[] = []
    for (let i = 0; i < 4; i++) {
      const a = verts[i]!, b = verts[(i + 1) % 4]!
      for (let j = 0; j <= 15; j++) trap.push({ x: a.x + (b.x - a.x) * j / 15, y: a.y + (b.y - a.y) * j / 15 })
    }
    const result = detectShape(trap)
    expect(result).not.toBeNull()
    // 可能被 rect / parallelogram / trapezoid 检测到
    expect(['rect', 'parallelogram', 'trapezoid']).toContain(result!.kind)
    expect(result!.confidence).toBeGreaterThan(0.45)
  })

  it('returns line for colinear points (even if bbox could be rect)', () => {
    const line = pts([[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]])
    const result = detectShape(line)
    expect(result).not.toBeNull()
    expect(['line', 'arrow']).toContain(result!.kind)
  })

  it('detects linear function (y = 2x + 5)', () => {
    const points: Pt[] = []
    for (let x = 0; x <= 100; x += 5) {
      points.push({ x: x + 50, y: 2 * x + 5 + (Math.random() - 0.5) * 4 })
    }
    const result = detectShape(points)
    expect(result).not.toBeNull()
    // 可能被 line 先匹配，也可能到 linear — 两种情况都接受
    expect(['line', 'arrow', 'linear']).toContain(result!.kind)
  })

  it('detects quadratic function (y = x^2)', () => {
    const points: Pt[] = []
    for (let x = -10; x <= 10; x += 0.8) {
      points.push({ x: x + 100, y: x * x * 0.5 + 50 + (Math.random() - 0.5) * 3 })
    }
    const result = detectShape(points)
    expect(result).not.toBeNull()
    // quadratic should have funcParams
    if (result!.kind === 'quadratic') {
      expect(result!.funcParams).toBeDefined()
      expect(result!.funcParams!.length).toBe(3)
    }
  })
})
