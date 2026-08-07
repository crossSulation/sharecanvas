import { describe, it, expect } from 'vitest'
import { docToJson, jsonToDoc, docToSnapshotHash, snapshotHashToDoc } from '../lib/serialize'
import type { Doc } from '../types'

const sampleDoc: Doc = {
  version: 1,
  strokes: [
    { id: 's1', kind: 'pen', points: [{ x: 10, y: 20 }, { x: 30, y: 40 }], color: '#000', size: 4, opacity: 1, seq: 1, layer: 'l1' },
  ],
  shapes: [
    { id: 'sh1', kind: 'rect', x0: 10, y0: 20, x1: 100, y1: 80, color: '#f00', size: 2, seq: 2, layer: 'l1' },
  ],
  texts: [
    { id: 't1', text: 'hello', x: 50, y: 50, color: '#000', size: 16, seq: 3, layer: 'l1' },
  ],
  objects: [
    { id: 'o1', kind: 'cube', pos: [0, 1, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#0f0' },
  ],
  eraser: [
    { id: 'e1', layer: 'l1', x: 5, y: 5, r: 10, seq: 4 },
  ],
  layers: [
    { id: 'l1', name: 'Layer 1', visible: true, locked: false, opacity: 1 },
  ],
}

describe('docToJson / jsonToDoc', () => {
  it('serializes and deserializes a doc', () => {
    const json = docToJson(sampleDoc)
    const parsed = jsonToDoc(json)
    expect(parsed).not.toBeNull()
    expect(parsed!.strokes).toHaveLength(1)
    expect(parsed!.shapes).toHaveLength(1)
    expect(parsed!.texts).toHaveLength(1)
    expect(parsed!.objects).toHaveLength(1)
    expect(parsed!.eraser).toHaveLength(1)
    expect(parsed!.layers).toHaveLength(1)
  })

  it('returns null for invalid JSON', () => {
    expect(jsonToDoc('not json')).toBeNull()
  })

  it('returns null for objects without arrays', () => {
    expect(jsonToDoc('{}')).toBeNull()
  })

  it('adds eraser array if missing', () => {
    const withoutEraser = { ...sampleDoc }
    delete (withoutEraser as Record<string, unknown>).eraser
    const doc = jsonToDoc(JSON.stringify(withoutEraser))
    expect(doc).not.toBeNull()
    expect(doc!.eraser).toEqual([])
  })
})

describe('docToSnapshotHash / snapshotHashToDoc', () => {
  it('round-trips a doc through snapshot hash', () => {
    const hash = docToSnapshotHash(sampleDoc)
    expect(hash).not.toBeNull()
    expect(hash).toMatch(/^#doc=/)
    const doc = snapshotHashToDoc(hash!)
    expect(doc).not.toBeNull()
    expect(doc!.strokes).toHaveLength(1)
    expect(doc!.texts[0].text).toBe('hello')
  })

  it('returns null for invalid hash', () => {
    expect(snapshotHashToDoc('#doc=!!!!')).toBeNull()
    expect(snapshotHashToDoc('')).toBeNull()
    expect(snapshotHashToDoc('not a hash')).toBeNull()
  })

  it('returns null for oversized docs', () => {
    const bigDoc: Doc = {
      ...sampleDoc,
      strokes: Array.from({ length: 5000 }, (_, i) => ({
        id: `s${i}`, kind: 'pen' as const,
        points: Array.from({ length: 10 }, (_, j) => ({ x: j * 10, y: j * 10 })),
        color: '#000', size: 4, opacity: 1, seq: i + 1, layer: 'l1',
      })),
    }
    expect(docToSnapshotHash(bigDoc)).toBeNull()
  })
})
