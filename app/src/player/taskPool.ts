/**
 * Run async work with a hard ceiling on how much of it is in flight at once.
 *
 * ## Why this exists
 *
 * `PlayScreen` has two per-cue fan-outs — a thumbnail grab and a duration
 * probe — and until this module neither had a limit. Adding N cues opened on
 * the order of 2N detached decoders at once, and that is not a theory: with 71
 * cues added from the job's own library, the heartbeat's own census read
 * `peak=142 opened=142`, and 65 of the 71 thumbnails never arrived
 * (`captures/measurements/decoder-load-2026-09-19-job-library.txt`).
 *
 * The limit belongs here rather than in `thumbnail.ts` or `mediaDuration.ts`.
 * Each of those does one job and does it correctly; it is the *caller* that
 * decides to do it seventy-one times at once, so the caller is where the
 * decision to do fewer at once has to live. One helper rather than two ad-hoc
 * queues, because a queue is the kind of code that is subtly wrong in a way
 * nothing notices, and one of them can be graded by `taskPool.test.ts` off
 * hardware while two cannot.
 *
 * ## What it does when it is broken
 *
 * A pool's two failure modes are opposite and both silent, so both are closed
 * by construction and graded in the test file:
 *
 * - **Letting too many through** puts the defect back and nothing says so.
 *   The slot is taken *before* the `await` that hands control back, and
 *   released by handing it directly to the next waiter rather than by
 *   decrementing and hoping the waiter increments before anyone else looks.
 *   Decrement-then-wake leaves a window in which a caller arriving in the same
 *   turn sees a free slot that is already promised, which is over-subscription
 *   that only shows up under load — exactly the conditions that hid the
 *   original defect.
 * - **Letting too few through**, or none, wedges the queue: the work never
 *   runs, and a caller that swallows rejections cannot tell a wedged pool from
 *   a slow one. The slot is released in a `finally`, so a task that rejects —
 *   or that throws before it ever returns a promise — frees its slot on the
 *   way out. A rejection is re-thrown to the caller unchanged; this module
 *   never converts a failure into a quiet nothing.
 *
 * A limit below one is rejected at construction rather than clamped. A pool
 * that accepts work and can never start it is the `allBlack([])` shape: it
 * would report no failures for ever, having done nothing at all.
 */

export interface TaskPool {
  /**
   * Run `task` when a slot is free, and settle exactly as it settles.
   *
   * Queued in call order, so a fan-out fills in the order the operator sees
   * on screen rather than in whatever order the decoders happen to finish.
   */
  run<T>(task: () => Promise<T>): Promise<T>
}

export function createTaskPool(limit: number): TaskPool {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`a task pool needs a limit of at least 1, got ${String(limit)}`)
  }

  /** Slots held: by a running task, or promised to a waiter that is about to run. */
  let held = 0
  const waiting: (() => void)[] = []

  const acquire = async (): Promise<void> => {
    if (held < limit) {
      held += 1
      return
    }
    await new Promise<void>((go) => waiting.push(go))
  }

  const release = (): void => {
    // Hand the slot over rather than freeing it. `held` is unchanged across a
    // handover, which is what makes the count safe to read at any point in
    // between — see the note above about the decrement-then-wake window.
    const next = waiting.shift()
    if (next === undefined) held -= 1
    else next()
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}
