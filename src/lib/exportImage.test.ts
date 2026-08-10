import { describe, expect, it } from 'vitest'
import { buildSvgString, docContentBounds } from './exportImage'
import type { Doc } from '../types'

function makeDoc(): Doc {
  return {
    version: 1,
    strokes: [
      {
        id: 's1',
        kind: 'pen',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
          { x: 0, y: 0 },
        ],
        color: '#18181b',
        size: 4,
        opacity: 1,
        seq: 1,
      },
    ],
    shapes: [
      { id: 'sh1', kind: 'rect', x0: 200, y0: 200, x1: 400, y1: 320, color: '#3b82f6', size: 3, seq: 2 },
      { id: 'sh2', kind: 'arrow', x0: 500, y0: 200, x1: 700, y1: 300, color: '#ef4444', size: 4, seq: 3 },
    ],
    texts: [{ id: 't1', x: 300, y: 100, text: 'hello & <world>', color: '#18181b', size: 24, seq: 4 }],
    objects: [],
    eraser: [],
    layers: [],
  }
}

describe('exportImage', () => {
  it('builds svg with all element types', () => {
    const svg = buildSvgString(makeDoc())
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('<path ')
    expect(svg).toContain('<rect ')
    expect(svg).toContain('<line ')
    expect(svg).toContain('<polygon ') // 箭头头部
    expect(svg).toContain('hello &amp; &lt;world&gt;')
    expect(svg).toContain('</svg>')
  })

  it('computes content bounds with padding', () => {
    const b = docContentBounds(makeDoc())
    expect(b.x0).toBeLessThan(0)
    expect(b.x1).toBeGreaterThan(700)
  })

  it('emits eraser mask when layer has erase circles', () => {
    const doc = makeDoc()
    doc.eraser = [{ id: 'e1', x: 50, y: 50, r: 10, seq: 5 }]
    const svg = buildSvgString(doc)
    expect(svg).toContain('<mask ')
    expect(svg).toContain('mask="url(#eraser-')
  })
})
