/**
 * The rate `mapper stream` sends at, and the rule that keeps the renderer from
 * composing faster than that.
 *
 * ## Why one constant
 *
 * The sidecar spawns `mapper stream --fps SEND_FPS`, and the render loop paces
 * itself to the same number. They used to be a literal `'30'` in `sidecar.ts`
 * and nothing at all in `App.tsx` — the renderer ran at whatever the display
 * refreshed at, and `mapper`'s one-slot `LatestFrame` mailbox overwrote every
 * frame it composed beyond thirty a second before any of them reached the wire.
 * On the 2026-09-05/06 job that was half of all composed frames, each one a
 * full-cost `drawImage` of the live clip (`docs/JOBS.md`).
 *
 * ## Why skipping is safe
 *
 * A skipped animation frame writes nothing, and that is not a gap on the wire:
 * `LatestFrame` re-sends whatever it last received, on `mapper`'s own
 * metronome, so a renderer that composes less often costs repeats at worst and
 * never silence. The render loop's rule was never "one write per animation
 * frame" for its own sake — it was "no path that stops writing", and every
 * frame this function admits still writes on every path.
 *
 * ## The tolerance
 *
 * `requestAnimationFrame` timestamps jitter by a millisecond or two, so a
 * strict `>= 1000 / SEND_FPS` would miss every second vsync on a 60 Hz display
 * about half the time and fall to 20 fps. The margin admits a frame that is up
 * to `PACING_TOLERANCE_MS` early. It is small enough that a 120 Hz display
 * (8.3 ms vsyncs) still composes every fourth vsync rather than every third.
 */

export const SEND_FPS = 30

export const PACING_TOLERANCE_MS = 4

const MIN_COMPOSE_INTERVAL_MS = 1_000 / SEND_FPS - PACING_TOLERANCE_MS

/**
 * Whether the animation frame at `now` should compose and write. `lastComposedAt`
 * is `null` before the first frame, which always composes.
 */
export function shouldCompose(now: number, lastComposedAt: number | null): boolean {
  return lastComposedAt === null || now - lastComposedAt >= MIN_COMPOSE_INTERVAL_MS
}

/**
 * How long a frame that is not moving goes without being written again.
 *
 * Longer than the frame interval of any ordinary clip (12 fps is 83 ms), so a
 * slow clip is composed on its own frames and never on this timer as well; far
 * shorter than the two seconds after which `electron/frameWatch.ts` calls the
 * renderer frozen, and than `mapper stream --pacing arrival`'s one-second
 * repeat.
 */
export const STILL_REWRITE_MS = 100

/**
 * What a compose drew: which source, and which of its frames. `frame` is the
 * source's `presentedFrames`, or `null` when it cannot say — black, or an
 * element that has no frame callbacks.
 */
export interface FrameMark {
  readonly source: unknown
  readonly frame: number | null
}

export interface ComposedFrame extends FrameMark {
  readonly at: number
}

/**
 * Whether the animation frame at `now` should compose and write, given what
 * the previous compose drew and what the wire source is showing now.
 *
 * ## Why a new frame, and not only the clock
 *
 * `shouldCompose` alone samples the element every other vsync at 30 fps, and a
 * 30 fps element presents a new frame every other vsync on a phase of its own.
 * Where the two sit close, rAF jitter decides which side of the change a
 * compose lands on, and the floor shows one frame twice and skips the next.
 * That was the ~8 % left at 30-on-30 under `--pacing arrival`, measured at the
 * renderer with `test/e2e/probe-render-rate.mjs`'s trace. Composing on the
 * vsync that carries a new frame removes the phase relation instead of
 * narrowing it.
 *
 * ## What still holds
 *
 * - Never above `SEND_FPS`: the time gate is checked first, always. A 60 fps
 *   clip is composed every second frame, as before.
 * - Every admitted frame writes, on every path — this only decides how often.
 * - A source that cannot say which frame it shows is gated by the clock alone,
 *   as before this existed. So is black.
 * - A frame that is not moving (paused, stalled, a still) is rewritten every
 *   `STILL_REWRITE_MS`, so the renderer never goes quiet on the sender.
 */
export function composeDue(now: number, last: ComposedFrame | null, current: FrameMark): boolean {
  if (last === null) return true
  if (!shouldCompose(now, last.at)) return false
  if (current.frame === null) return true
  if (current.source !== last.source || current.frame !== last.frame) return true
  return now - last.at >= STILL_REWRITE_MS
}
