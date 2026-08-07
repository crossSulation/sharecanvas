import { describe, it, expect } from 'vitest'
import { createId, roomCode } from '../lib/id'

describe('createId', () => {
  it('returns a string starting with the prefix', () => {
    const id = createId('test')
    expect(id).toMatch(/^test_/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()))
    expect(ids.size).toBe(100)
  })

  it('uses default prefix "id"', () => {
    const id = createId()
    expect(id).toMatch(/^id_/)
  })
})

describe('roomCode', () => {
  it('returns a string of the given length', () => {
    expect(roomCode(5)).toHaveLength(5)
    expect(roomCode(8)).toHaveLength(8)
  })

  it('returns 5 characters by default', () => {
    expect(roomCode()).toHaveLength(5)
  })

  it('only contains valid characters', () => {
    const validChars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    for (let i = 0; i < 50; i++) {
      const code = roomCode(10)
      for (const c of code) {
        expect(validChars).toContain(c)
      }
    }
  })

  it('generates different codes', () => {
    const codes = new Set(Array.from({ length: 100 }, () => roomCode()))
    expect(codes.size).toBeGreaterThan(90)
  })
})
