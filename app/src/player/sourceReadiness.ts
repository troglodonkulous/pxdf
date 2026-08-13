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
export class SourceReadiness {
  private readyValue = false
  private failedValue = false
  private disposedValue = false

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
   * Mark the media unplayable.
   *
   * Ignored after teardown: a disposed element fires `error` as its `src` is
   * removed, and a source that reported a failure on the way out would put a
   * banner in front of the operator describing a cue nobody was playing.
   */
  fail(): void {
    if (this.disposedValue) return
    this.failedValue = true
  }

  /** Returns true on the first call only, which is the one that owns teardown. */
  dispose(): boolean {
    if (this.disposedValue) return false
    this.disposedValue = true
    return true
  }
}
