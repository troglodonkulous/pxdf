/**
 * Ask a decoder how long its media is.
 *
 * The inspector's `Media` button fills the duration field from the clip itself,
 * which means opening a second decoder for a cue that may already be on the
 * floor. The live one must not be touched — reading its `mediaDurationMs`
 * would be free, but it only exists while the cue is live, and the operator
 * needs the number for cues that are not playing.
 *
 * So this polls a throwaway probe, and the caller owns disposing it. Polling
 * rather than listening for `loadedmetadata` is deliberate: the event may have
 * already fired by the time anyone subscribes, and a listener that misses its
 * event produces a button that does nothing at all, which is the failure this
 * project keeps finding at the bottom of things. Reading state cannot miss.
 *
 * Every exit is loud. There is no path that resolves with a length nobody
 * measured: an unreadable file rejects, and a probe that never answers rejects
 * on the deadline rather than leaving the caller's `await` pending for the rest
 * of the session.
 */

/** The part of a `VideoSource` this needs, so a test does not need a DOM. */
export interface DurationProbe {
  readonly mediaDurationMs: number | null
  readonly failed: boolean
}

export interface ProbeOptions {
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly wait?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export const PROBE_TIMEOUT_MS = 5_000
const POLL_MS = 50

export async function probeDurationMs(probe: DurationProbe, options: ProbeOptions = {}): Promise<number> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const pollMs = options.pollMs ?? POLL_MS
  const wait = options.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = options.now ?? (() => performance.now())
  const deadline = now() + timeoutMs

  for (;;) {
    // Failure first. A source that has failed may still be carrying a duration
    // from a previous load, and a number read off a broken decoder is worse
    // than no number: it would land in the show file looking deliberate.
    if (probe.failed) throw new Error('could not read the media')
    const duration = probe.mediaDurationMs
    if (duration !== null) return duration
    // Checked after the duration, so a probe that answers exactly on the
    // deadline is believed rather than discarded.
    if (now() >= deadline) throw new Error('timed out reading the media length')
    await wait(pollMs)
  }
}
