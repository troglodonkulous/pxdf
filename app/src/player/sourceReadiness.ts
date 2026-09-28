/**
 * When a decoder is ready, when it is dead, and which of those wins.
 *
 * This is the part of `VideoSource` that decides things, separated from the
 * part that talks to an `HTMLVideoElement`. It exists apart from that class
 * because the rules below are all about ordering and latching — what happens
 * when a source fails after it was ready, what happens when a frame arrives
 * after teardown — and those are exactly the cases a real element makes hard to
 * produce on demand and easy to get wrong. jsdom is not an option here (two
 * harnesses, no third), so logic that cannot be tested without a DOM is logic
 * that is graded only by the wire gate, and the wire gate cannot dispose a
 * source at an interesting moment.
 *
 * What is deliberately *not* here: which `readyState` counts as a decoded
 * frame. That threshold is `HTMLMediaElement.HAVE_CURRENT_DATA`, and it belongs
 * next to the DOM constant that defines it rather than as a `2` copied into a
 * module that cannot check it. `videoSource.ts` does that comparison and passes
 * the answer in.
 *
 * The three states are one-way. A source that has failed never becomes ready
 * again — the engine's response to `failed` is to release the slot, so there is
 * nothing for a recovery to recover into.
 */
/**
 * Which of the element's two independent "no data" conditions a stall is.
 *
 * They are separate because they end separately, and conflating them is how a
 * warning outlives its condition. `fetch` is the download having gone quiet
 * (`stalled`), which ends when bytes arrive again (`progress`) — playback need
 * never have halted, so nothing playback-shaped fires to end it. `playback` is
 * the element having actually run out (`waiting`), which ends when it resumes
 * (`playing`) or has enough data to (`canplay`) — and bytes arriving is *not*
 * that: a `progress` during a `waiting` is a download filling a buffer the
 * floor is still frozen behind.
 */
export type StallKind = 'fetch' | 'playback'

export class SourceReadiness {
  private readyValue = false
  private failedValue = false
  private disposedValue = false
  private failureReasonValue: string | null = null
  private fetchStallValue: string | null = null
  private playbackStallValue: string | null = null

  get ready(): boolean {
    return this.readyValue
  }

  get failed(): boolean {
    return this.failedValue
  }

  get disposed(): boolean {
    return this.disposedValue
  }

  /**
   * Why this source is dead, in the words of whatever noticed.
   *
   * Non-null exactly when `failed` is true — the invariant that stops a failure
   * reaching the operator as the bare word "failed", which is what it did
   * before: `onError` discarded `video.error` entirely, so a codec the decoder
   * could not open, a file that was not there and a canvas the compositor could
   * not read back all arrived at the banner as the same sentence.
   */
  get failureReason(): string | null {
    return this.failureReasonValue
  }

  /**
   * Set while the element says it is waiting for data, cleared when it says it
   * is not. Distinct from `failed` in both directions: a stall clears on its
   * own, and a failure is not a stall.
   *
   * This is a *condition*, not an event, which is why it is a nullable field
   * read live rather than something latched. A cue that recovers after two
   * seconds of buffering must stop reporting a stall without anyone having to
   * remember to clear it, or the first slow clip of the night leaves a warning
   * up for the rest of the show — the cry-wolf shape `CLAUDE.md` names.
   *
   * Two conditions, one line, and `playback` wins when both hold: a floor that
   * is frozen right now is the more useful of two true things to tell the
   * operator, and the fetch behind it is why.
   */
  get stallReason(): string | null {
    return this.playbackStallValue ?? this.fetchStallValue
  }

  /**
   * Report whether the element has a decoded frame, and answer whether this
   * source counts as ready now.
   *
   * The return value is *is ready*, not *became ready*, and the difference is
   * load-bearing. `videoSource.ts` drives this from
   * `requestVideoFrameCallback` as "if it did not come back ready, ask for
   * another frame" — so a transition-style return would answer false on every
   * call after the first and re-arm the callback for ever, on a source that was
   * ready the whole time.
   */
  observe(hasDecodedFrame: boolean): boolean {
    if (this.disposedValue || this.failedValue || !hasDecodedFrame) return false
    this.readyValue = true
    return true
  }

  /**
   * Mark the media unplayable, and say why.
   *
   * The reason is required rather than optional on purpose. An optional one is
   * a hole that closes itself over time — every new failure path takes the
   * shorter call, and the field goes back to being null for most of the
   * failures that actually happen, which is the state this whole change exists
   * to leave. A caller that cannot name a reason has to write that down.
   *
   * The *first* reason wins. Failures cascade — a decode error stops the
   * element, then the next `draw` finds nothing to draw and fails again — and
   * the second report is a consequence of the first. Keeping the earliest one
   * keeps the diagnosis rather than the symptom it caused.
   *
   * Ignored after teardown: a disposed element fires `error` as its `src` is
   * removed, and a source that reported a failure on the way out would put a
   * banner in front of the operator describing a cue nobody was playing.
   */
  fail(reason: string): void {
    if (this.disposedValue) return
    this.failedValue = true
    this.failureReasonValue ??= reason
    // A dead source is not a buffering one. Leaving a stall up beside a failure
    // offers the operator two readings of one cue, and the transient one is the
    // wrong one to act on.
    this.fetchStallValue = null
    this.playbackStallValue = null
  }

  /** The element says it is waiting for data. Ignored once dead or disposed. */
  stall(kind: StallKind, reason: string): void {
    if (this.disposedValue || this.failedValue) return
    if (kind === 'playback') this.playbackStallValue = reason
    else this.fetchStallValue = reason
  }

  /**
   * The element says that condition is over — the named one, and only it.
   *
   * Clearing both from either signal is the bug this parameter exists to stop,
   * in both directions: a `progress` while playback is still halted would take
   * the warning down over a frozen floor, and a `playing` cannot vouch for a
   * fetch that is still quiet.
   */
  clearStall(kind: StallKind): void {
    if (kind === 'playback') this.playbackStallValue = null
    else this.fetchStallValue = null
  }

  /** Returns true on the first call only, which is the one that owns teardown. */
  dispose(): boolean {
    if (this.disposedValue) return false
    this.disposedValue = true
    return true
  }
}
