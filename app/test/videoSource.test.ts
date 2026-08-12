import { describe, expect, it } from 'vitest'
import { coverRect } from '../src/player/videoSource'

describe('coverRect', () => {
  it('centre-crops a source that is wider than the box', () => {
    const rect = coverRect(1_920, 1_080, 80, 80)
    expect(rect.x).toBeCloseTo(-31.111_111)
    expect(rect.y).toBe(0)
    expect(rect.width).toBeCloseTo(142.222_222)
    expect(rect.height).toBe(80)
  })

  it('centre-crops a source that is taller than the box', () => {
    const rect = coverRect(1_080, 1_920, 80, 40)
    expect(rect.x).toBe(0)
    expect(rect.y).toBeCloseTo(-51.111_111)
    expect(rect.width).toBe(80)
    expect(rect.height).toBeCloseTo(142.222_222)
  })

  it('fits an exact aspect match without cropping', () => {
    expect(coverRect(160, 80, 80, 40)).toEqual({ x: 0, y: 0, width: 80, height: 40 })
  })

  it.each([
    [0, 1_080],
    [Number.NaN, 1_080],
  ])('returns a finite empty rect for an unavailable %s x %s source', (width, height) => {
    const rect = coverRect(width, height, 80, 40)
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(Object.values(rect).every(Number.isFinite)).toBe(true)
  })
})
