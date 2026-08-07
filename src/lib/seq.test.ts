import { describe, it, expect } from 'vitest'
import { initSeq, nextSeq } from '../lib/seq'

describe('nextSeq', () => {
  it('returns incrementing values', () => {
    const a = nextSeq()
    const b = nextSeq()
    const c = nextSeq()
    expect(b).toBe(a + 1)
    expect(c).toBe(b + 1)
  })
})

describe('initSeq', () => {
  it('can set counter higher', () => {
    const current = nextSeq()
    initSeq(current + 10)
    expect(nextSeq()).toBe(current + 11)
  })

  it('does not lower the counter', () => {
    const current = nextSeq()
    initSeq(current - 100)
    expect(nextSeq()).toBe(current + 1)
  })
})
