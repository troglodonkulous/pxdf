import { describe, expect, it } from 'vitest'
import { coverRect, rotatedTargetSize, trimWrapPoint } from '../src/player/videoSource'

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

/**
 * The trim-wrap check, as a pure function so it is gradeable under `vitest`
 * without a DOM (`docs/APP-PLAN.md`, "no jsdom, no third harness" — a real
 * `HTMLVideoElement` is graded only by `wire.mjs`).
 *
 * `VideoSource.draw` calls this on every drawn frame, never on `timeupdate` —
 * that event fires roughly every 250 ms, and by the time it fired the floor
 * would already be showing content past the cue's out-point. `draw` runs once
 * per `requestAnimationFrame`, which is what "per-frame" means here.
 *
 * Units are milliseconds throughout, matching `Cue.trimStartMs`/`trimEndMs`;
 * `VideoSource` converts `HTMLVideoElement.currentTime` (seconds) at the call
 * site so this function stays free of that unit conversion.
 */
describe('trimWrapPoint', () => {
  it('never wraps when trimEnd is open (play to the end of the media)', () => {
    expect(trimWrapPoint(0, 0, null)).toBe(null)
    expect(trimWrapPoint(999_999, 1_000, null)).toBe(null)
  })

  it('does not wrap before the out-point', () => {
    expect(trimWrapPoint(4_999, 1_000, 5_000)).toBe(null)
  })

  it('wraps to trimStart exactly at the out-point', () => {
    expect(trimWrapPoint(5_000, 1_000, 5_000)).toBe(1_000)
  })

  it('wraps to trimStart once playback has passed the out-point', () => {
    // A dropped frame or a slow tab can land past the boundary rather than on
    // it; the check still has to fire, not wait for an exact match.
    expect(trimWrapPoint(5_250, 1_000, 5_000)).toBe(1_000)
  })

  it('wraps to a non-zero in-point, not to zero', () => {
    expect(trimWrapPoint(5_000, 1_200, 5_000)).toBe(1_200)
  })
})
