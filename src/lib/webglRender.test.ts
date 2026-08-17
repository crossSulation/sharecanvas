import { describe, it, expect } from 'vitest'
import { parseColor, triangulatePolygon } from './webglRender'

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
