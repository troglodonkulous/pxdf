import { describe, expect, it } from 'vitest'
import { coverRect, rotatedTargetSize } from '../src/player/videoSource'

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

/**
 * The target `VideoSource.draw` cover-fits a cue's video against, before
 * rotating the drawn result into place. Swapping width/height at 90/270
 * mirrors `render/geometry.ts`'s `canvasSize` — a cue authored 80 x 40 and
 * rotated 90 degrees has to cover-fit into a 40 x 80 target, or a landscape
 * clip gets cropped as if it were already portrait.
 */
describe('rotatedTargetSize', () => {
  it('leaves the target alone at 0 and 180', () => {
    expect(rotatedTargetSize(80, 40, 0)).toEqual({ width: 80, height: 40 })
    expect(rotatedTargetSize(80, 40, 180)).toEqual({ width: 80, height: 40 })
  })

  it('swaps width and height at 90 and 270', () => {
    expect(rotatedTargetSize(80, 40, 90)).toEqual({ width: 40, height: 80 })
    expect(rotatedTargetSize(80, 40, 270)).toEqual({ width: 40, height: 80 })
  })
})
