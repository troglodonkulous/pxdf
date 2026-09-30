import { describe, expect, it } from 'vitest'
import { PACING_TOLERANCE_MS, SEND_FPS, shouldCompose } from '../src/render/framePacing.js'

/** Drive `shouldCompose` over a run of vsync timestamps, and count what it admits. */
function composedPerSecond(vsyncMs: number, jitterMs: (i: number) => number = () => 0): number {
  let last: number | null = null
  let composed = 0
  const frames = Math.round(10_000 / vsyncMs)
  for (let i = 0; i < frames; i += 1) {
    const now = i * vsyncMs + jitterMs(i)
    if (shouldCompose(now, last)) {
      composed += 1
      last = now
    }
  }
  return composed / 10
}

describe('shouldCompose', () => {
  it('always composes the first frame', () => {
    expect(shouldCompose(0, null)).toBe(true)
  })

  it('holds a 60 Hz display to the send rate, not above it', () => {
    expect(composedPerSecond(1_000 / 60)).toBeCloseTo(SEND_FPS, 0)
  })

  it('holds a 120 Hz display to the send rate, not above it', () => {
    expect(composedPerSecond(1_000 / 120)).toBeCloseTo(SEND_FPS, 0)
  })

  // The case the tolerance exists for. Without it, a vsync that lands a
  // millisecond early is refused, the next one is a full extra frame late, and
  // a 60 Hz display falls towards 20 fps -- below the sender, which is the one
  // direction this gate must never push.
  it('does not fall below the send rate when rAF timestamps jitter', () => {
    const jitter = (i: number): number => (i % 2 === 0 ? -1.5 : 1.5)
    expect(composedPerSecond(1_000 / 60, jitter)).toBeCloseTo(SEND_FPS, 0)
  })

  it('never composes twice inside one send interval', () => {
    expect(shouldCompose(1_000 / SEND_FPS - PACING_TOLERANCE_MS - 0.5, 0)).toBe(false)
  })

  // A renderer that stalls must compose on the very next frame it gets, not
  // wait out a second interval on top of the stall.
  it('composes immediately after a stall', () => {
    expect(shouldCompose(500, 0)).toBe(true)
  })
})
