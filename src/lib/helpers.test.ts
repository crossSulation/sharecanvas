import { describe, it, expect } from 'vitest'
import { clamp, distToSegment, distToPolyline, distToPolygon, itemBounds, findItem } from '../components/canvasHelpers'
import type { Doc, Pt, Shape, Stroke, TextItem } from '../types'

describe('clamp', () => {
  it('clamps a value within range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })
})

describe('distToSegment', () => {
  it('returns distance to the closest point on a segment', () => {
    const p: Pt = { x: 3, y: 0 }
    const a: Pt = { x: 0, y: 0 }
    const b: Pt = { x: 6, y: 0 }
    expect(distToSegment(p, a, b)).toBe(0)
  })

  it('returns distance when point is off segment', () => {
    const p: Pt = { x: 3, y: 4 }
    const a: Pt = { x: 0, y: 0 }
    const b: Pt = { x: 6, y: 0 }
    expect(distToSegment(p, a, b)).toBeCloseTo(4)
  })

  it('handles zero-length segment', () => {
    const p: Pt = { x: 3, y: 4 }
    const a: Pt = { x: 1, y: 1 }
    expect(distToSegment(p, a, a)).toBeCloseTo(Math.hypot(2, 3))
  })
})

describe('distToPolyline', () => {
  it('returns Infinity for empty points', () => {
    expect(distToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity)
  })

  it('returns distance to single point', () => {
    expect(distToPolyline({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBeCloseTo(5)
  })

  it('returns 0 when point is on polyline', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
    expect(distToPolyline({ x: 5, y: 0 }, pts)).toBeCloseTo(0)
  })
})

describe('distToPolygon', () => {
  it('returns Infinity for less than 3 points', () => {
    expect(distToPolygon({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Infinity)
  })

  it('returns 0 when point is inside polygon', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(distToPolygon({ x: 5, y: 5 }, pts)).toBe(0)
  })

  it('returns edge distance when point is outside', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    const dist = distToPolygon({ x: 5, y: 12 }, pts)
    expect(dist).toBeCloseTo(2)
  })
})

describe('itemBounds', () => {
  it('returns bounds for strokes', () => {
    const s: Stroke = {
      id: 's1', kind: 'pen', points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      color: '#000', size: 4, opacity: 1, seq: 1, layer: 'l1',
    }
    const b = itemBounds(s)
    expect(b.x0).toBe(10)
    expect(b.y0).toBe(20)
    expect(b.x1).toBe(30)
    expect(b.y1).toBe(40)
  })

  it('returns bounds for shapes', () => {
    const sh: Shape = {
      id: 'sh1', kind: 'rect', x0: 10, y0: 20, x1: 100, y1: 80,
      color: '#f00', size: 2, seq: 1, layer: 'l1',
    }
    const b = itemBounds(sh)
    expect(b.x0).toBe(10)
    expect(b.x1).toBe(100)
  })

  it('returns bounds for text', () => {
    const t: TextItem = {
      id: 't1', text: 'hello', x: 50, y: 50,
      color: '#000', size: 16, seq: 1, layer: 'l1',
    }
    const b = itemBounds(t)
    expect(b.x0).toBeLessThan(t.x)
    expect(b.x1).toBeGreaterThan(t.x)
  })
})

describe('findItem', () => {
  const doc: Doc = {
    version: 1,
    strokes: [{ id: 's1', kind: 'pen', points: [{ x: 0, y: 0 }], color: '#000', size: 4, opacity: 1, seq: 1, layer: 'l1' }],
    shapes: [{ id: 'sh1', kind: 'rect', x0: 0, y0: 0, x1: 10, y1: 10, color: '#000', size: 2, seq: 2, layer: 'l1' }],
    texts: [{ id: 't1', text: 'hi', x: 5, y: 5, color: '#000', size: 12, seq: 3, layer: 'l1' }],
    objects: [],
    eraser: [],
    layers: [],
  }

  it('finds strokes by id', () => {
    const ref = findItem(doc, 's1')
    expect(ref).not.toBeNull()
    expect(ref!.kind).toBe('stroke')
  })

  it('finds shapes by id', () => {
    const ref = findItem(doc, 'sh1')
    expect(ref).not.toBeNull()
    expect(ref!.kind).toBe('shape')
  })

  it('finds texts by id', () => {
    const ref = findItem(doc, 't1')
    expect(ref).not.toBeNull()
    expect(ref!.kind).toBe('text')
  })

  it('returns null for unknown id', () => {
    expect(findItem(doc, 'nonexistent')).toBeNull()
  })
})
