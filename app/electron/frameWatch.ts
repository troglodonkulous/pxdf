/**
 * Is the renderer still producing frames, and what should that change?
 *
 * ## The blind spot this closes
 *
 * `Sidecar` re-sends its last frame for ever when nothing new arrives, which is
 * the correct behaviour for a renderer that is briefly busy and the wrong one
 * for a renderer that is gone. Nothing else in the app can tell those apart:
 *
 *   - the status pill reads `sending`, and is right — the Python child is
 *     healthy and 600 packets a second are leaving the machine
 *   - the wire carries a valid, non-black frame, so `wire.mjs`'s one-sided
 *     "no black appeared" check cannot see it either
 *   - no error is published, because on this path nothing failed
 *
 * So a React tree that unmounts — the render effect's cleanup fires
 * `cancelAnimationFrame`, `writeFrame` is never called again — leaves the floor
 * holding a frozen picture with every indicator in the app reading healthy.
 * That is the shape of the fault that sent the last job back to the older
 * build, and it is invisible from every existing channel by construction.
 *
 * ## Level-triggered, like `nicWatch.ts`
 *
 * Same contract and for the same reason: `main.ts` polls and passes whatever
 * the current answer is, so one missed tick costs a second rather than a lost
 * transition. The caller publishes on the *edge* — the message deliberately
 * carries no elapsed-seconds counter, so a banner that is already up is
 * byte-identical to the one this returns and the caller can skip the republish.
 * A banner rewriting itself once a second, and a log line once a second behind
 * it, is the flood that teaches an operator to stop reading both.
 *
 * `clearBanner` is copied from `nicWatch.ts`, condition for condition: this
 * watcher owns exactly the message it published, and recovery takes that
 * message down only while it is still the one on screen. If a sidecar death
 * replaced it in the meantime, recovery here must not clear the replacement.
 *
 * ## Two conditions, not one
 *
 * `stopped` is the frozen-floor case above. `never started` is the blank window
 * — `#root` empty because every asset 404'd, which this project has shipped
 * once already (see the `base: './'` note in `vite.config.ts`) and which
 * produced, in that file's own words, "no error dialog, no console the operator
 * would ever see". Both are "no frames are arriving"; they need different
 * sentences because they send the reader to different places.
 *
 * Graded by `app/test/frameWatch.test.ts`, including the mutation-check on the
 * arming guard — a watchdog that fires before the first frame has had a chance
 * to arrive is a channel that cries wolf at every launch.
 */

/**
 * How long without a frame before the floor is declared frozen.
 *
 * 2 s is 60 missed frames at the renderer's 30 fps floor rate. Long enough that
 * a garbage-collection pause, a cue change that touches a decoder, or a window
 * drag cannot reach it; short enough that an operator watching a frozen floor
 * gets told inside the time it takes them to wonder.
 */
const FROZEN_AFTER_MS = 2_000

/**
 * How long after the page loads before "no frames yet" becomes a fault.
 *
 * Mounting React and reaching the first `requestAnimationFrame` is milliseconds.
 * 5 s is not a threshold that needs tuning — it is an order of magnitude of
 * headroom over the only legitimate path to this state.
 */
const STARTUP_GRACE_MS = 5_000

export interface FrameWatchState {
  /** When the renderer last delivered a framebuffer, or null if it never has. */
  readonly lastFrameAt: number | null
  /** When the current window finished loading, or null if no window is up. */
  readonly windowReadyAt: number | null
  readonly now: number
  /** The message this watcher last published, or null. */
  readonly lastWatchdogBanner: string | null
  /** The message actually on screen right now, whoever published it. */
  readonly currentBanner: string | null
}

export function frameVerdict(state: FrameWatchState): {
  banner: string | null
  clearBanner: boolean
  watchdogBanner: string | null
} {
  const { lastFrameAt, windowReadyAt, now, lastWatchdogBanner, currentBanner } = state

  // No window is up, so nothing is expected to be drawing. This is the ordinary
  // state between `before-quit` and exit, and on macOS after the last window is
  // closed while the app stays alive — `main.ts` writes a black frame on that
  // path deliberately, and a watchdog barking about it would be reporting the
  // app doing the right thing.
  const banner = windowReadyAt === null
    ? null
    : lastFrameAt === null
      ? now - windowReadyAt > STARTUP_GRACE_MS
        ? 'the window loaded but has never produced a frame — nothing has reached the floor this session'
        : null
      : now - lastFrameAt > FROZEN_AFTER_MS
        ? 'the renderer has stopped producing frames — the floor is holding its last picture'
        : null

  return {
    banner,
    clearBanner: lastWatchdogBanner !== null && currentBanner === lastWatchdogBanner && banner === null,
    watchdogBanner: banner,
  }
}
