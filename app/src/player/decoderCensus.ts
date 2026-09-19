/**
 * How many `<video>` decoders this window is holding open, right now.
 *
 * ## Why this exists
 *
 * The job on 2026-09-05/06 produced 116 `PIPELINE_ERROR_DECODE` failures across
 * 38 clips, and the leading explanation is decoder fan-out: adding N cues opens
 * roughly 2N detached decoders at once — one thumbnail grab and one duration
 * probe per cue (`PlayScreen.tsx`, neither of them rate-limited) — on top of the
 * three the engine holds for live, pending and preview. Chromium's decoder pool
 * is finite and a clip that loses the race fails with a message that is
 * indistinguishable from a clip that is genuinely undecodable.
 *
 * That hypothesis is not testable from the log, because nothing in the app has
 * ever said how many decoders were open. This module is that channel and
 * nothing more: it changes no behaviour, imposes no limit, and refuses nothing.
 * Its whole job is to make the next job's log able to answer the question.
 *
 * ## What it does when it is broken
 *
 * A census that only counts up is worse than no census: it would report a fake
 * exhaustion, and this project's own rule is that a channel which cries wolf is
 * a destroyed channel. So the count has to come *down*, and the two things that
 * could stop it doing so are guarded by construction rather than by discipline:
 *
 * - There is no `release(id)` to call with the wrong argument, and no way to
 *   release something that was never opened. `openDecoder` hands back the only
 *   token that can close that one entry.
 * - That token is idempotent. `VideoSource.dispose` is already idempotent and
 *   `captureThumbnail` releases in a `finally` that can run after an earlier
 *   throw; a second call must not decrement a second time, or `live` drifts
 *   negative and the instrument starts lying in the reassuring direction.
 *
 * `live` can therefore never go below zero and never exceed `opened`, and
 * `decoderCensus.test.ts` grades both, including the double-release path.
 *
 * ## Why three numbers and not one
 *
 * `live` alone cannot distinguish "nothing ever opened a decoder" from "they
 * all opened and closed cleanly" — the same silence-reads-as-success shape the
 * heartbeat itself exists to avoid. `opened` is the work the session actually
 * did, and `peak` is the answer to the fan-out question: a `peak` of 3 during a
 * run that added forty clips disproves the hypothesis outright, and a `peak` in
 * the dozens is the first evidence for it anyone has had.
 *
 * Counted per `VideoSource`, not per `document.createElement('video')` call, so
 * the element-injection seam the constructor keeps for tests stays intact — a
 * `VideoSource` drives exactly one element whoever made it, and it is the
 * lifetime of the source that decides how long that element is held.
 */

export interface DecoderCensus {
  /** Decoders held open this instant. */
  readonly live: number;
  /** The high-water mark since the window loaded. Never reset, never decreases. */
  readonly peak: number;
  /** Every decoder ever opened by this window. Never decreases. */
  readonly opened: number;
}

let live = 0;
let peak = 0;
let opened = 0;

/**
 * Record that a decoder has been opened.
 *
 * @returns the one function that closes this entry. Idempotent: calling it
 *          twice releases once, because the call sites that own it are
 *          `finally` blocks and idempotent `dispose`s.
 */
export function openDecoder(): () => void {
  live += 1;
  opened += 1;
  if (live > peak) peak = live;

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    live -= 1;
  };
}

export function decoderCensus(): DecoderCensus {
  return { live, peak, opened };
}

/**
 * Put the census back to nothing.
 *
 * For tests only — module state is shared across a file's cases, and a count
 * carried in from the previous case is the instrument grading itself. Nothing
 * in the app calls this: the window's own lifetime is the census's, and a
 * reload builds a fresh module instance anyway.
 */
export function resetDecoderCensus(): void {
  live = 0;
  peak = 0;
  opened = 0;
}
