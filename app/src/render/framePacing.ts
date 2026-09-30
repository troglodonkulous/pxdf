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
