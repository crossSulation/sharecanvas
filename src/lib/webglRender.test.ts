import { describe, it, expect } from 'vitest'
import { parseColor, triangulatePolygon, dashPolyline } from './webglRender'

describe('parseColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseColor('#18181b')).toEqual([24 / 255, 24 / 255, 27 / 255, 1])
  })

  it('parses 3-digit hex', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1, 1])
  })

  it('parses rgba()', () => {
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5])
  })
})

describe('triangulatePolygon', () => {
  it('triangulates a CCW square into 2 triangles', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    const tris = triangulatePolygon(sq)
    expect(tris.length).toBe(6)
  })

  it('triangulates a CW square (winding-independent)', () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ]
    const tris = triangulatePolygon(sq)
    expect(tris.length).toBe(6)
  })

  it('triangulates a concave polygon', () => {
    // 凹多边形（L 形）
    const l = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 4 },
      { x: 0, y: 4 },
    ]
    const tris = triangulatePolygon(l)
    // 6 边形 → 4 个三角形（12 个索引）
    expect(tris.length).toBe(12)
  })

  it('returns empty for degenerate input', () => {
    expect(triangulatePolygon([])).toEqual([])
    expect(triangulatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([])
  })
})

describe('dashPolyline', () => {
  it('splits a horizontal line into dashes', () => {
    const segs = dashPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 3, 2)
    // dash 3 + gap 2 + dash 3 + gap 2 = 10
    expect(segs.length).toBe(2)
    expect(segs[0]![0]).toEqual({ x: 0, y: 0 })
    expect(segs[0]![1]).toEqual({ x: 3, y: 0 })
    expect(segs[1]![0]).toEqual({ x: 5, y: 0 })
    expect(segs[1]![1]).toEqual({ x: 8, y: 0 })
  })

  it('continues phase across edges', () => {
    const segs = dashPolyline(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 6 },
      ],
      4,
      2,
    )
    // edge1: dash [0,4] (full), then edge2 starts in gap [0,2], dash [2,6]
    expect(segs.length).toBe(2)
    expect(segs[0]![0]).toEqual({ x: 0, y: 0 })
    expect(segs[0]![1]).toEqual({ x: 4, y: 0 })
    expect(segs[1]![0]).toEqual({ x: 4, y: 2 })
    expect(segs[1]![1]).toEqual({ x: 4, y: 6 })
  })

  it('returns empty for degenerate input', () => {
    expect(dashPolyline([], 3, 2)).toEqual([])
    expect(dashPolyline([{ x: 0, y: 0 }], 3, 2)).toEqual([])
    expect(dashPolyline([{ x: 0, y: 0 }, { x: 5, y: 0 }], 0, 2)).toEqual([])
  })
})
