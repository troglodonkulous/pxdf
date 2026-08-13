/**
 * The player engine: what goes on the wire, decided once per rendered frame.
 *
 * This module is the gate-critical half of PR 2, and it is deliberately free of
 * the DOM. It never touches a canvas, a video element or an IPC channel — it is
 * given a factory for `FrameSource`s and a clock, and each tick it returns which
 * source the caller should draw and whether the wire gets that or black. That is
 * what makes PR 2's gate gradeable under a plain unit-test runner instead of
 * inside a headless Electron: the invariants below are about *sequence*, and a
 * sequence is much easier to assert over a fake clock than over a real one.
 *
 * ## Why the assertions are here rather than on the wire
 *
 * `Sidecar` re-sends its last frame forever when the renderer stalls. That is
 * correct — a hitch in Chromium must not gap the floor — but it means a capture
 * off the wire *cannot distinguish a perfectly gapless cue change from a
 * renderer that froze mid-change*. Both look like a continuous stream of valid
 * frames. Grading "gapless" from a UDP capture would therefore be exactly the
 * shape of result `CLAUDE.md` opens with: an instrument that reports success
 * for the failure it exists to detect. So gaplessness is asserted on what this
 * engine *decides*, frame by frame, and the wire capture is left to grade the
 * thing it can genuinely see — that black is black, and that the socket stays
 * open.
 *
 * ## The three invariants
 *
 *   1. **Idle, BLACKOUT and cue gaps are black frames, not silence.** Stopping
 *      the send does not black the floor: controller 1 reverts to the vendor's
 *      own content about five seconds later, and controllers 2 and 3 hold their
 *      last frame indefinitely. So `tick()` always returns a wire decision, and
 *      the caller always writes something.
 *   2. **A cue change never shows black.** The incoming source is created and
 *      started *before* it is put on the wire, and the outgoing one keeps
 *      rendering until the incoming one reports a decoded first frame. A cue
 *      therefore overruns its duration rather than gapping, which is the right
 *      trade for a floor in front of people.
 *   3. **Preview never reaches the wire.** In preview mode the operator
 *      auditions an inactive cue on screen while the floor keeps doing whatever
 *      Live had it doing. The wire decision is computed from live state only,
 *      and no code path lets the preview source into it.
 */

import type { Cue, Show } from './show';

/**
 * One playable piece of media, as the engine needs to see it.
 *
 * The renderer's implementation wraps an `HTMLVideoElement`; the tests' wraps
 * nothing at all. Note there is no `draw` here: drawing is the caller's job,
 * which is what keeps this file free of canvas types. Callers recover their own
 * concrete type through the generic parameter.
 */
export interface FrameSource {
  /**
   * True once a first frame is decoded and the source can go on the wire
   * without showing black. This is the whole of invariant 2 — everything else
   * is bookkeeping around it.
   */
  readonly ready: boolean;
  /** Terminal: the media will never play. A missing file, a codec, a decode error. */
  readonly failed: boolean;
  /** Playback position within the media, in milliseconds. */
  readonly positionMs: number;
  /** The media's own length, once known. Not the cue's duration. */
  readonly mediaDurationMs: number | null;
  play(): void;
  pause(): void;
  /** Release the decoder. Called exactly once per source by the engine. */
  dispose(): void;
}

export type PlayerMode = 'live' | 'preview';

/** What the caller should put on a surface this frame. */
export type Target<S extends FrameSource> =
  | { readonly kind: 'black' }
  | { readonly kind: 'source'; readonly source: S };

const BLACK: Target<never> = { kind: 'black' };

export interface Tick<S extends FrameSource> {
  /** The floor. Black for idle, BLACKOUT and cue gaps; never absent. */
  readonly wire: Target<S>;
  /** The on-screen floor preview. Mirrors the wire in live mode. */
  readonly screen: Target<S>;
  /** Master brightness, 0..1, for the caller to hand to `onePass`. */
  readonly master: number;
}

/** A plain-data view of engine state, for React to render from. */
export interface EngineSnapshot {
  readonly mode: PlayerMode;
  readonly blackout: boolean;
  readonly master: number;
  readonly transportPaused: boolean;
  readonly liveCueId: string | null;
  /** The cue GO will fire next, and the one the stack marks Standby. */
  readonly standbyCueId: string | null;
  /** Armed by GO, not yet on the wire because it has not decoded a frame. */
  readonly pendingCueId: string | null;
  /** The cue being auditioned on screen. Preview mode only. */
  readonly previewCueId: string | null;
  /** How long the live cue has been live, in milliseconds. */
  readonly elapsedMs: number;
  /** The live cue's duration, or null when it holds until GO. */
  readonly cueDurationMs: number | null;
  /**
   * Set when a cue could not be played, and cleared when the surface it
   * happened on is working again or gone — not when the operator presses GO.
   * See `ErrorSurface`.
   */
  readonly lastError: string | null;
}

export interface EngineOptions<S extends FrameSource> {
  readonly show: Show;
  /** Builds a source for a cue. Called once per armed cue; never on a tick path. */
  readonly createSource: (cue: Cue) => S;
  /** Injected so tests can drive time. Defaults to `performance.now`. */
  readonly now?: () => number;
}

interface Slot<S extends FrameSource> {
  readonly cue: Cue;
  readonly source: S;
}

/**
 * Which operator-visible surface an error is about.
 *
 * There is one banner and two places a cue can fail, and they do not mean the
 * same thing: a preview that will not decode is an annoyance, a floor that has
 * gone black is the show. Tagging the error is what stops a success on one
 * surface from clearing an error about the other — previewing a good clip while
 * the floor is dark must not take the banner down.
 *
 * `pending` failures are tagged `live`. A cue that was armed by GO is on its way
 * to the wire, and the operator is watching for it to arrive there.
 */
type ErrorSurface = 'live' | 'preview';

export class PlayerEngine<S extends FrameSource> {
  private show: Show;
  private readonly createSource: (cue: Cue) => S;
  private readonly now: () => number;

  private live: Slot<S> | null = null;
  private pending: Slot<S> | null = null;
  private preview: Slot<S> | null = null;

  private mode: PlayerMode = 'live';
  private blackout = false;
  private master = 1;
  private transportPaused = false;

  private standbyCueId: string | null = null;
  /**
   * True when the operator chose the Standby cue themselves and it has not been
   * fired yet.
   *
   * Without this, `promotePending` overwrites Standby with whatever follows the
   * cue that just went live — and the window in which it does that is exactly
   * the window in which the operator has time to pick the next cue. GO, a
   * second or two of decoding, a click on cue 9, the change lands, and Standby
   * is silently back on cue 3. Firing a cue consumes the choice, because the
   * cue they picked is now the one on the floor.
   */
  private standbyPinned = false;
  private liveStartedAt = 0;
  /** Time already elapsed on the live cue before the last pause. */
  private elapsedBeforePause = 0;
  private lastError: string | null = null;
  private lastErrorSurface: ErrorSurface | null = null;

  constructor(options: EngineOptions<S>) {
    this.show = options.show;
    this.createSource = options.createSource;
    this.now = options.now ?? (() => performance.now());
    this.standbyCueId = this.show.cues[0]?.id ?? null;
  }

  // ---------------------------------------------------------------- commands

  /**
   * Replace the show.
   *
   * A cue that is live or armed and no longer exists in the new show is torn
   * down, which takes the player idle — and idle is black, not a held frame.
   * Editing the stack under a running show is ordinary during a load-in.
   */
  setShow(show: Show): void {
    this.show = show;
    const has = (id: string | null): boolean => id !== null && show.cues.some((cue) => cue.id === id);

    if (this.live !== null && !has(this.live.cue.id)) this.clearLive();
    if (this.pending !== null && !has(this.pending.cue.id)) this.pending = this.release(this.pending);
    if (this.preview !== null && !has(this.preview.cue.id)) this.preview = this.release(this.preview);
    if (!has(this.standbyCueId)) {
      this.standbyCueId = this.cueAfter(this.live?.cue.id ?? null)?.id ?? null;
      this.standbyPinned = false;
    }
  }

  setMode(mode: PlayerMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Leaving preview releases the decoder rather than leaving it running
    // behind a surface nobody is looking at. Live is untouched in both
    // directions: switching modes must never disturb the floor.
    if (mode === 'live') {
      this.preview = this.release(this.preview);
      // The surface the error was about is now off screen, so the banner has
      // nothing left to refer to. Without this it survives to the end of the
      // session, describing a decoder that no longer exists.
      this.resolve('preview');
    }
  }

  setBlackout(blackout: boolean): void {
    this.blackout = blackout;
  }

  setMaster(master: number): void {
    if (!(master >= 0 && master <= 1)) throw new Error(`master out of range: ${master}`);
    this.master = master;
  }

  /**
   * Select a cue.
   *
   * In live mode this arms it as Standby — the cue GO will fire — and does not
   * touch the floor. In preview mode it auditions the cue on screen, which is
   * the whole point of the mode.
   */
  selectCue(cueId: string): void {
    const cue = this.cueById(cueId);
    if (cue === null) return;

    if (this.mode === 'preview') {
      if (this.preview?.cue.id === cueId) return;
      this.preview = this.release(this.preview);
      this.preview = this.arm(cue);
      return;
    }
    this.standbyCueId = cueId;
    this.standbyPinned = true;
  }

  /**
   * GO: fire the standby cue.
   *
   * The incoming source starts decoding immediately but does not reach the wire
   * until it reports `ready`, so the outgoing cue keeps rendering across the
   * change. Pressing GO again while one is armed replaces the armed cue.
   */
  go(): void {
    const cue = this.cueById(this.standbyCueId);
    if (cue === null) return;

    this.pending = this.release(this.pending);
    this.pending = this.arm(cue);
    // Firing consumes the operator's choice: the cue they picked is the one
    // going to the floor, so Standby is free to advance when the change lands.
    // A selection made *after* this, while the change is still in flight, pins
    // it again and survives the promotion.
    this.standbyPinned = false;
    // No error clearing here, deliberately. GO is a request; the banner reports
    // outcomes. Clearing at arm time meant pressing GO on a cue that cannot
    // decode blanked the banner and then refilled it a frame or two later, and
    // the blank is what the operator sees at the one moment they are looking.
    // `promotePending` clears it, when content is actually on the wire.
  }

  /** Fire a specific cue immediately, bypassing Standby. Double-click in the stack. */
  goTo(cueId: string): void {
    if (this.cueById(cueId) === null) return;
    this.standbyCueId = cueId;
    this.go();
  }

  /** Transport: step Standby, without firing. */
  selectNext(): void {
    const next = this.cueAfter(this.standbyCueId);
    if (next === null) return;
    this.standbyCueId = next.id;
    this.standbyPinned = true;
  }

  selectPrevious(): void {
    const previous = this.cueBefore(this.standbyCueId);
    if (previous === null) return;
    this.standbyCueId = previous.id;
    this.standbyPinned = true;
  }

  /**
   * Transport pause/resume.
   *
   * Pause freezes the media, so the floor holds the paused frame — this is a
   * held *sent* frame, not a stopped send, so controller 1 does not revert.
   */
  setPaused(paused: boolean): void {
    if (paused === this.transportPaused) return;
    this.transportPaused = paused;

    if (paused) {
      this.elapsedBeforePause = this.now() - this.liveStartedAt + this.elapsedBeforePause;
      this.live?.source.pause();
    } else {
      this.liveStartedAt = this.now();
      this.live?.source.play();
    }
  }

  /** Take the player idle: no live cue, black on the wire. */
  stopPlayback(): void {
    this.clearLive();
    this.pending = this.release(this.pending);
  }

  /** Release every decoder. The caller still has to stop calling `tick`. */
  dispose(): void {
    this.clearLive();
    this.pending = this.release(this.pending);
    this.preview = this.release(this.preview);
  }

  // ------------------------------------------------------------------- ticks

  /**
   * Advance the player by one rendered frame and say what to draw.
   *
   * Ordering inside matters and is not arbitrary: failures are reaped before a
   * promotion so a dead pending cue cannot reach the wire, the promotion runs
   * before the duration check so a cue that arrives exactly at its predecessor's
   * end does not spend a frame in limbo, and the duration check runs last so it
   * sees the cue that is actually live this frame.
   */
  tick(): Tick<S> {
    this.reapFailures();
    this.promotePending();
    this.advanceOnDuration();

    // A decoding preview answers a preview error. Reading the state is safe
    // here, where the live equivalent would not be: `reapFailures` released the
    // failed preview on the same tick it recorded it, so a preview that is
    // ready is never the one the banner is talking about.
    if (this.preview?.source.ready === true) this.resolve('preview');

    const liveTarget: Target<S> =
      this.live === null || this.blackout ? BLACK : { kind: 'source', source: this.live.source };

    // The wire is computed from live state alone. Preview has no path to it —
    // not a flag that suppresses it, no path at all.
    const wire = liveTarget;

    let screen: Target<S> = liveTarget;
    if (this.mode === 'preview') {
      const preview = this.preview;
      screen = preview !== null && preview.source.ready ? { kind: 'source', source: preview.source } : BLACK;
    }

    return { wire, screen, master: this.master };
  }

  snapshot(): EngineSnapshot {
    return {
      mode: this.mode,
      blackout: this.blackout,
      master: this.master,
      transportPaused: this.transportPaused,
      liveCueId: this.live?.cue.id ?? null,
      standbyCueId: this.standbyCueId,
      pendingCueId: this.pending?.cue.id ?? null,
      previewCueId: this.preview?.cue.id ?? null,
      elapsedMs: this.elapsedMs(),
      cueDurationMs: this.live?.cue.durationMs ?? null,
      lastError: this.lastError,
    };
  }

  // ----------------------------------------------------------------- private

  private elapsedMs(): number {
    if (this.live === null) return 0;
    if (this.transportPaused) return this.elapsedBeforePause;
    return this.now() - this.liveStartedAt + this.elapsedBeforePause;
  }

  private reapFailures(): void {
    if (this.pending?.source.failed === true) {
      this.fail('live', `cue ${JSON.stringify(this.pending.cue.name)} failed to play`);
      this.pending = this.release(this.pending);
    }
    if (this.live?.source.failed === true) {
      // The floor goes black rather than to the next cue. An automatic advance
      // here would put unrelated content up at the moment something is already
      // wrong, with nothing on screen to say why.
      this.fail('live', `cue ${JSON.stringify(this.live.cue.name)} stopped playing`);
      this.clearLive();
    }
    if (this.preview?.source.failed === true) {
      this.fail('preview', `cue ${JSON.stringify(this.preview.cue.name)} failed to preview`);
      this.preview = this.release(this.preview);
    }
  }

  private fail(surface: ErrorSurface, message: string): void {
    this.lastError = message;
    this.lastErrorSurface = surface;
  }

  /** Take the banner down, but only if it is about the surface that recovered. */
  private resolve(surface: ErrorSurface): void {
    if (this.lastErrorSurface !== surface) return;
    this.lastError = null;
    this.lastErrorSurface = null;
  }

  private promotePending(): void {
    const pending = this.pending;
    if (pending === null || !pending.source.ready) return;

    // The incoming source is installed before the outgoing one is released, so
    // there is no instant at which neither is available to draw.
    const outgoing = this.live;
    this.live = pending;
    this.pending = null;
    this.liveStartedAt = this.now();
    this.elapsedBeforePause = 0;
    if (this.transportPaused) pending.source.pause();
    this.release(outgoing);

    // Standby advances only if the operator has not chosen one since GO. See
    // `standbyPinned`: overwriting a deliberate choice here throws away the
    // thing they did while waiting for this very change to land.
    if (!this.standbyPinned) this.standbyCueId = this.cueAfter(pending.cue.id)?.id ?? null;

    // Content is on the wire, which is the only event that answers a live
    // error. This has to be the promotion rather than the state "live exists
    // and is ready" — that state is also true one tick after a *pending* cue
    // failed underneath a healthy live one, and resolving from it would erase
    // that error a frame after recording it.
    this.resolve('live');
  }

  private advanceOnDuration(): void {
    const live = this.live;
    if (live === null || this.transportPaused) return;

    const duration = live.cue.durationMs;
    // A null duration holds until GO with the media looping underneath. An
    // already-armed cue means the change is in flight, and re-arming it here
    // would restart the decode every frame and guarantee the gap it is meant
    // to prevent.
    if (duration === null || this.pending !== null || this.elapsedMs() < duration) return;

    const next = this.cueById(this.standbyCueId);
    if (next === null) {
      // End of the stack. Idle is black, and the send continues.
      this.clearLive();
      return;
    }
    this.pending = this.arm(next);
    this.standbyPinned = false;
  }

  private arm(cue: Cue): Slot<S> {
    const source = this.createSource(cue);
    source.play();
    return { cue, source };
  }

  /**
   * Drop a slot's decoder.
   *
   * The teardown is guarded because it is called from `tick`, and `tick` is
   * called from the render loop. A `HTMLVideoElement` whose object URL has
   * already been revoked, or which has been detached, can throw on teardown —
   * and an exception out of `tick` ends the render loop, which stops the writes,
   * which leaves `Sidecar` re-sending one frame to a floor nobody is driving
   * any more. A decoder that will not close is a leak; a render loop that stops
   * is the show.
   */
  private release(slot: Slot<S> | null): null {
    try {
      slot?.source.dispose();
    } catch {
      // Nothing useful to do with it, and nothing safe to do but continue.
    }
    return null;
  }

  private clearLive(): void {
    this.live = this.release(this.live);
    this.liveStartedAt = this.now();
    this.elapsedBeforePause = 0;
  }

  private cueById(cueId: string | null): Cue | null {
    if (cueId === null) return null;
    return this.show.cues.find((cue) => cue.id === cueId) ?? null;
  }

  private cueAfter(cueId: string | null): Cue | null {
    const index = this.show.cues.findIndex((cue) => cue.id === cueId);
    if (index < 0) return this.show.cues[0] ?? null;
    return this.show.cues[index + 1] ?? null;
  }

  private cueBefore(cueId: string | null): Cue | null {
    const index = this.show.cues.findIndex((cue) => cue.id === cueId);
    if (index <= 0) return null;
    return this.show.cues[index - 1] ?? null;
  }
}
