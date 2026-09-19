/**
 * What the renderer costs per frame, and how many decoders it is holding, as
 * one field of the heartbeat line.
 *
 * ## Why the main process has to say it
 *
 * The renderer is the only process that can measure any of this and the last
 * one that can be trusted to report it. Everything the app knows about
 * composition cost has lived in a React readout since PR 1: four characters on
 * the Play surface, overwritten four times a second, gone at the next restart,
 * and invisible to anyone reading the log afterwards — which is every
 * investigation this project has ever run. The 2026-09-05/06 job produced 116
 * `PIPELINE_ERROR_DECODE` failures whose leading explanation is decoder
 * fan-out, and neither the decoder count nor the per-frame readback cost that
 * would test it appears anywhere in the nine hours of log that job wrote.
 *
 * So the numbers travel renderer -> main over `ddf:render-stats` and come out
 * in the heartbeat, which is the one line in the file that is emitted whether
 * or not anything is wrong.
 *
 * ## The cadence, and why there is not a new one
 *
 * `App.tsx`'s render loop already batches: it accumulates per frame and calls
 * `setStats` once every 250 ms. That existing tick is the seam this rides on,
 * so a sample crosses the IPC boundary four times a second rather than sixty,
 * and `log.ts`'s standing rule — it is never called per frame — is honoured by
 * arithmetic rather than by hope. The main process folds each sample into a
 * window and prints one summary a minute.
 *
 * Sums and maxima cross the wire, not averages. A heartbeat is a minute of
 * 250 ms samples, and averaging an average would weight a sample that saw four
 * frames the same as one that saw fifteen. The max travels because the max is
 * what a dropped frame is made of: a mean readback of 2 ms with a 40 ms worst
 * case is a different machine from a flat 2 ms, and the mean alone cannot tell
 * them apart.
 *
 * ## What this does when it is broken
 *
 * This is the field most able to lie by omission, so it is the one written
 * hardest against it. There are three states and they are three different
 * strings:
 *
 * - **`renderer=never-reported`** — no sample has ever arrived. Printing `0`
 *   or leaving the field out would both read as a healthy idle renderer, which
 *   is exactly the silence-reads-as-success failure the heartbeat exists to
 *   remove. It is also the correct and expected reading before a window has
 *   loaded and after the last one closes.
 * - **`renderer=SILENT`** — samples arrived once and have stopped. Upper case
 *   because it is a fault, and it is a fault this project has already shipped:
 *   the render loop's 250 ms block sits downstream of `composeFrame`, and the
 *   `SecurityError` storm killed everything downstream of composition for a
 *   whole session while every other indicator read healthy.
 * - **`renderer=live`** — a sample arrived inside `SILENT_AFTER_MS`.
 *
 * Read it against `frames=` on the same line, because the two are produced by
 * the same loop and should rise and fall together. `frames=3600/60s` beside
 * `renderer=SILENT` is not two faults, it is one finding: `writeFrame` is
 * running and the sampling block after it is not — which is the shape of the
 * defect above, one storey up, and no other pair of fields in this app can see
 * it.
 *
 * A window with no composed frames in it prints `draw=- readback=- pass=-` and
 * never `0.00`. An idle show composes nothing, and a zero would claim an
 * instantaneous readback was measured when nothing was measured at all.
 */

/**
 * One 250 ms batch from the render loop.
 *
 * Totals and maxima over the frames in that batch; `composes` is the number of
 * frames those totals are made of, and it is not the same as the number of
 * animation frames — the loop composes twice per frame when Preview is showing
 * something other than Live, and not at all when the floor is black.
 */
export interface RenderSample {
  readonly composes: number
  readonly drawMsTotal: number
  readonly readbackMsTotal: number
  readonly passMsTotal: number
  readonly drawMsMax: number
  readonly readbackMsMax: number
  readonly passMsMax: number
  /** `<video>` decoders open this instant — see `src/player/decoderCensus.ts`. */
  readonly decodersLive: number
  /** High-water mark since the page loaded. */
  readonly decodersPeak: number
  /** Every decoder the page has ever opened. */
  readonly decodersOpened: number
}

export interface RenderWindow {
  /** The most recent sample, whenever it came, or null if none ever has. */
  readonly last: RenderSample | null
  /** When that sample arrived, in `Date.now()` terms. */
  readonly lastAt: number | null
  readonly composes: number
  readonly drawMsTotal: number
  readonly readbackMsTotal: number
  readonly passMsTotal: number
  readonly drawMsMax: number
  readonly readbackMsMax: number
  readonly passMsMax: number
}

/**
 * How long without a sample before the renderer is called silent.
 *
 * Deliberately the same 2 s as `frameWatch.ts`'s `FROZEN_AFTER_MS`, and for the
 * same reason: both are driven by the same `requestAnimationFrame` loop, so a
 * pause long enough to trip one is long enough to trip the other, and two
 * different thresholds would let the log contradict itself about a single
 * event. 2 s is eight missed samples — beyond any garbage-collection pause, a
 * cue change or a window drag.
 */
const SILENT_AFTER_MS = 2_000

export function emptyRenderWindow(): RenderWindow {
  return {
    last: null,
    lastAt: null,
    composes: 0,
    drawMsTotal: 0,
    readbackMsTotal: 0,
    passMsTotal: 0,
    drawMsMax: 0,
    readbackMsMax: 0,
    passMsMax: 0,
  }
}

export function foldRenderSample(window: RenderWindow, sample: RenderSample, at: number): RenderWindow {
  return {
    last: sample,
    lastAt: at,
    composes: window.composes + sample.composes,
    drawMsTotal: window.drawMsTotal + sample.drawMsTotal,
    readbackMsTotal: window.readbackMsTotal + sample.readbackMsTotal,
    passMsTotal: window.passMsTotal + sample.passMsTotal,
    drawMsMax: Math.max(window.drawMsMax, sample.drawMsMax),
    readbackMsMax: Math.max(window.readbackMsMax, sample.readbackMsMax),
    passMsMax: Math.max(window.passMsMax, sample.passMsMax),
  }
}

/**
 * Start the next heartbeat window, keeping what is known about the renderer.
 *
 * `last`/`lastAt` survive on purpose. They are what lets a heartbeat with no
 * samples in it still say *when* the renderer went quiet and what it was
 * holding when it did, rather than degrading to `never-reported` — which would
 * be a different and false claim, and would reset itself to a clean-looking
 * state once a minute for the rest of a broken session.
 */
export function rollRenderWindow(window: RenderWindow): RenderWindow {
  return { ...emptyRenderWindow(), last: window.last, lastAt: window.lastAt }
}

function ms(total: number, count: number): string {
  // `-`, not `0.00`. A window that composed nothing measured nothing, and a
  // number here would be read as a measurement of an instantaneous frame.
  if (count <= 0) return '-'
  return (total / count).toFixed(2)
}

function seconds(value: number): string {
  return (Math.max(0, value) / 1_000).toFixed(1)
}

/**
 * The `renderer=...` portion of the heartbeat line.
 *
 * Always a non-empty string: there is no state of this instrument that prints
 * nothing, because a missing field is the one outcome a reader cannot tell from
 * a healthy one.
 */
export function renderField(window: RenderWindow, now: number): string {
  const { last, lastAt } = window
  if (last === null || lastAt === null) return 'renderer=never-reported'

  const age = now - lastAt
  const health = age > SILENT_AFTER_MS ? 'SILENT' : 'live'
  return [
    `renderer=${health}`,
    `age=${seconds(age)}s`,
    `composes=${window.composes}`,
    `draw=${ms(window.drawMsTotal, window.composes)}/${window.composes > 0 ? window.drawMsMax.toFixed(2) : '-'}ms`,
    `readback=${ms(window.readbackMsTotal, window.composes)}/${window.composes > 0 ? window.readbackMsMax.toFixed(2) : '-'}ms`,
    `pass=${ms(window.passMsTotal, window.composes)}/${window.composes > 0 ? window.passMsMax.toFixed(2) : '-'}ms`,
    `decoders=${last.decodersLive}`,
    `peak=${last.decodersPeak}`,
    `opened=${last.decodersOpened}`,
  ].join(' ')
}
