import { describe, expect, it } from 'vitest'
import {
  composeDue,
  type ComposedFrame,
  PACING_TOLERANCE_MS,
  SEND_FPS,
  shouldCompose,
  STILL_REWRITE_MS,
} from '../src/render/framePacing.js'

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

/**
 * Compose on a new video frame, not on a clock. The residue `--pacing arrival`
 * left at 30-on-30 (7.3-9.6 %, `captures/measurements/README.md`) was the
 * renderer composing one video frame twice and its successor never: the time
 * gate samples the element every other vsync, and a 30 fps element presents a
 * new frame every other vsync too, at a phase of its own. Wherever the two sit
 * close, jitter decides which side of the change a compose lands on.
 */
describe('composeDue', () => {
  const VSYNC = 1_000 / 60

  /**
   * Drive `composeDue` over `seconds` of vsyncs and return the frame drawn at
   * each compose. `frameAt(t)` is the newest frame the element has presented by
   * vsync time `t` (`null`: the source cannot say), and is what a compose at
   * `t` draws.
   */
  function drive(
    frameAt: (t: number) => number | null,
    options: { vsync?: number; seconds?: number; jitter?: (i: number) => number; source?: (t: number) => unknown } = {},
  ): Array<{ t: number; frame: number | null }> {
    const vsync = options.vsync ?? VSYNC
    const seconds = options.seconds ?? 10
    const source = options.source ?? (() => 'clip')
    let last: ComposedFrame | null = null
    const composed: Array<{ t: number; frame: number | null }> = []
    for (let i = 0; i * vsync < seconds * 1_000; i += 1) {
      const t = i * vsync + (options.jitter?.(i) ?? 0)
      const current = { source: source(t), frame: frameAt(t) }
      if (composeDue(t, last, current)) {
        last = { at: t, ...current }
        composed.push({ t, frame: current.frame })
      }
    }
    return composed
  }

  const steps = (composed: Array<{ frame: number | null }>): number[] =>
    composed.slice(1).map((c, i) => (c.frame as number) - (composed[i].frame as number))

  /**
   * A 30 fps element whose frames become drawable on a clock of its own —
   * frame k at `k * 33.3 + 0.3` ms — seen by any rAF at or after that, with
   * rAF jitter of up to ±0.8 ms. Each change lands within a millisecond of the
   * vsync a time-gated compose samples on, which is where it goes wrong.
   */
  const nearBoundary = (t: number): number => Math.floor((t - 0.3) / (1_000 / 30))
  const rafJitter = (i: number): number => ((i * 7) % 5) * 0.4 - 0.8

  // From the second compose: the first is admitted before frame 0 exists, and
  // the cap then holds the rAF that frame 0 arrives on — a start transient,
  // not the steady state this is about.
  it('composes every frame of a 30 fps element exactly once', () => {
    const composed = drive(nearBoundary, { jitter: rafJitter })
    const s = steps(composed.slice(1))
    expect(s.length).toBeGreaterThan(250)
    expect(s.every((step) => step === 1)).toBe(true)
  })

  // The control: the same element through the time gate alone does judder.
  // If this ever reads clean, the case above is not testing anything.
  it('is needed: the time gate alone repeats and skips on the same element', () => {
    let last: number | null = null
    const frames: number[] = []
    for (let i = 0; i * VSYNC < 10_000; i += 1) {
      const t = i * VSYNC + rafJitter(i)
      if (shouldCompose(t, last)) {
        last = t
        frames.push(nearBoundary(t))
      }
    }
    const s = frames.slice(1).map((f, i) => f - frames[i])
    expect(s.filter((step) => step !== 1).length).toBeGreaterThan(10)
  })

  it('still holds a 60 fps element to the send rate, every second frame', () => {
    const composed = drive((t) => Math.floor(t / VSYNC + 0.5))
    expect(composed.length / 10).toBeCloseTo(SEND_FPS, 0)
    expect(steps(composed).every((step) => step === 2)).toBe(true)
  })

  it('never exceeds the send rate, whatever the display and the element', () => {
    const composed = drive((t) => Math.floor(t / 4), { vsync: 1_000 / 120 })
    expect(composed.length / 10).toBeLessThanOrEqual(SEND_FPS + 0.1)
  })

  it('composes a 24 fps element once per frame, not on a 30 fps clock', () => {
    const composed = drive((t) => Math.floor((t - 3) / (1_000 / 24)))
    expect(composed.length / 10).toBeCloseTo(24, 0)
    expect(steps(composed).every((step) => step === 1)).toBe(true)
  })

  // A paused or stalled element presents nothing new. The floor still gets a
  // frame often enough that nothing downstream mistakes it for a dead
  // renderer, and no more often than the send rate.
  it('rewrites a frame that is not moving, at least every STILL_REWRITE_MS', () => {
    const composed = drive(() => 42)
    const gaps = composed.slice(1).map((c, i) => c.t - composed[i].t)
    // The count first: with no gaps at all, the two bounds below hold vacuously.
    expect(gaps.length).toBeGreaterThan(10_000 / (STILL_REWRITE_MS + 1_000 / 60) - 2)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(STILL_REWRITE_MS + VSYNC + 1e-9)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(STILL_REWRITE_MS)
  })

  // Longer than the longest frame interval of an ordinary clip, so a slow
  // clip is composed on its frames rather than on this timer as well.
  it('does not rewrite between the frames of a 12 fps clip', () => {
    const composed = drive((t) => Math.floor((t - 5) / (1_000 / 12)))
    expect(steps(composed).every((step) => step === 1)).toBe(true)
  })

  // Black, and an element with no frame callbacks: nothing says when a new
  // frame arrives, so the gate is the time gate it was before.
  it('falls back to the time gate when the source cannot say which frame it shows', () => {
    const composed = drive(() => null)
    expect(composed.length / 10).toBeCloseTo(SEND_FPS, 0)
  })

  // 5,050 ms is off the still-rewrite grid (every sixth vsync from 0), so a
  // rewrite that happens to fall on the switch cannot pass for it.
  it('composes a different source at once, even on the same frame count', () => {
    const composed = drive(() => 7, { source: (t) => (t < 5_050 ? 'a' : 'b') })
    const at = composed.find((c) => c.t >= 5_050)
    expect(at).toBeDefined()
    expect((at as { t: number }).t).toBeLessThan(5_050 + VSYNC + 1)
  })

  it('always composes the first frame', () => {
    expect(composeDue(0, null, { source: 'clip', frame: 3 })).toBe(true)
  })
})
