import { describe, it, expect } from 'vitest'
import { scaleBucket, TEXT_FONT } from './glyphAtlas'

describe('scaleBucket', () => {
  it('clamps to [1, 8]', () => {
    expect(scaleBucket(0.01)).toBe(1)
    expect(scaleBucket(0)).toBe(1)
    expect(scaleBucket(-3)).toBe(1)
    expect(scaleBucket(NaN)).toBe(1)
    expect(scaleBucket(100)).toBe(8)
  })

  it('snaps to powers of two', () => {
    expect(scaleBucket(1)).toBe(1)
    expect(scaleBucket(1.3)).toBe(1)
    expect(scaleBucket(1.8)).toBe(2)
    expect(scaleBucket(2)).toBe(2)
    expect(scaleBucket(3.5)).toBe(4)
    expect(scaleBucket(4)).toBe(4)
    expect(scaleBucket(7)).toBe(8)
  })

  it('covers typical zoom*dpr range', () => {
    // zoom 0.15..8, dpr<=2 → scale 0.3..16，桶应落在 1/2/4/8
    expect([1, 2, 4, 8]).toContain(scaleBucket(0.15 * 2))
    expect([1, 2, 4, 8]).toContain(scaleBucket(8 * 2))
  })
})

describe('TEXT_FONT', () => {
  it('includes CJK fallbacks', () => {
    expect(TEXT_FONT).toContain('PingFang SC')
    expect(TEXT_FONT).toContain('sans-serif')
  })
})
