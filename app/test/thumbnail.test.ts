import { describe, expect, it } from 'vitest'
import { clampSeekSeconds, THUMB_HEIGHT, THUMB_WIDTH } from '../src/player/thumbnail'

/**
 * `captureThumbnail` itself needs a real decoder and is graded by `wire.mjs`
 * — see "Two harnesses, and no third" in `docs/APP-PLAN.md`. This is the one
 * piece of that file's logic with no DOM in it.
 */
describe('clampSeekSeconds', () => {
  it('defaults to the first frame', () => {
    expect(clampSeekSeconds(0, 10)).toBe(0)
  })

  it('converts milliseconds to seconds', () => {
    expect(clampSeekSeconds(2_500, 10)).toBe(2.5)
  })

  it('clamps to just short of the clip end rather than the exact duration', () => {
    // Seeking to the exact end lands on a frame that may never fire `seeked`
    // in some containers — see the comment on the function itself.
    expect(clampSeekSeconds(9_000, 3)).toBe(2.99)
    expect(clampSeekSeconds(100_000, 3)).toBe(2.99)
  })

  it('never goes negative for a negative or non-finite timestamp', () => {
    expect(clampSeekSeconds(-500, 10)).toBe(0)
    expect(clampSeekSeconds(Number.NaN, 10)).toBe(0)
  })

  it('returns 0 for a duration that is not usable yet', () => {
    // `video.duration` is `NaN` before metadata loads and `Infinity` for some
    // live/streamed sources; neither is a length to clamp against.
    expect(clampSeekSeconds(1_000, Number.NaN)).toBe(0)
    expect(clampSeekSeconds(1_000, 0)).toBe(0)
    expect(clampSeekSeconds(1_000, -1)).toBe(0)
  })

  it('does not clamp below zero for a very short clip', () => {
    expect(clampSeekSeconds(0, 0.005)).toBe(0)
  })
})

describe('thumbnail size', () => {
  it('matches the plan: ~40x24', () => {
    expect(THUMB_WIDTH).toBe(40)
    expect(THUMB_HEIGHT).toBe(24)
  })
})
