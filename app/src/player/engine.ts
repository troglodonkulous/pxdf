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

import type { Rotation } from '../render/geometry';
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
  /**
   * Apply a cue-authored rotation to an already-armed source.
   *
   * `reseat` keeps the same decoder across an edit to a cue that is already
   * playing — see its own comment — which means rotation, unlike a value the
   * engine reads straight off `Cue`, has to be pushed into the source
   * explicitly or a live cue's rotation control would visibly do nothing
   * until the next GO re-armed it.
   */
  setRotation(rotation: Rotation): void;
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

/**
 * A failure, and the cue it is about.
 *
 * The cue is held by id and the text is held as the *reason* alone, so the
 * banner's wording is built when it is read rather than when it was recorded.
 * Both halves matter and for the same reason: a cue's name and a cue's presence
 * are both things the operator changes while the banner is up. An earlier
 * version stored the finished sentence, so renaming the offending cue left the
 * banner naming something no longer in the stack — the same defect as an error
 * outliving its cue, one layer down.
 */
interface SurfaceError {
  readonly cueId: string;
  /**
   * The media the failure was about.
   *
   * A failure is about a cue *and a file*, not a cue. Replacing the media under
   * a cue that would not play is the operator fixing the problem, and an error
   * that survives it condemns a file nothing has tried yet — the banner says
   * the new clip is broken on the strength of the old one.
   */
  readonly path: string;
  /** Verb phrase completing `cue "<name>" …`. */
  readonly reason: string;
}

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
  /**
   * One error per surface, rather than one error and a tag.
   *
   * The tagged version had a hole exactly the shape of the defect it was built
   * to prevent. Tagging stopped a preview *success* from clearing a live error
   * and did nothing about a preview *failure* overwriting it — so a dead floor,
   * followed by a preview that also would not decode, left the banner owned by
   * the preview, and leaving preview took it down. Black floor, no banner.
   *
   * Two slots cannot be overwritten by each other, which removes the class
   * rather than the instance.
   *
   * Each carries the cue it is about, so that `setShow` can retire an error
   * whose cue has been deleted. A message naming a cue that is no longer in the
   * stack cannot be acted on, and the operator's usual response to a clip that
   * will not decode is to remove it — which would otherwise leave the banner up
   * for the rest of the show, over a floor that is working.
   */
  private liveError: SurfaceError | null = null;
  private previewError: SurfaceError | null = null;

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
   *
   * A cue that *does* still exist has its slot pointed at the new definition.
   * Slots capture their `Cue` at `arm()`, so without this an edit to a cue that
   * is already playing reaches the show file and never reaches the floor: the
   * engine goes on reading the duration the cue had when GO was pressed. The
   * inspector's duration control is exactly that edit, and it would have looked
   * like it worked everywhere except where it mattered.
   */
  setShow(show: Show): void {
    this.show = show;
    const has = (id: string | null): boolean => id !== null && show.cues.some((cue) => cue.id === id);

    if (this.live !== null) {
      const live = this.reseat(this.live);
      if (live === null) this.clearLive();
      else this.live = live;
    }
    this.pending = this.reseat(this.pending) ?? this.release(this.pending);
    this.preview = this.reseat(this.preview) ?? this.release(this.preview);
    if (!has(this.standbyCueId)) {
      this.standbyCueId = this.cueAfter(this.live?.cue.id ?? null)?.id ?? null;
      this.standbyPinned = false;
    }
    this.retireStaleErrors();
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
      this.fail('live', this.pending.cue, 'failed to play');
      this.pending = this.release(this.pending);
    }
    if (this.live?.source.failed === true) {
      // The floor goes black rather than to the next cue. An automatic advance
      // here would put unrelated content up at the moment something is already
      // wrong, with nothing on screen to say why.
      this.fail('live', this.live.cue, 'stopped playing');
      this.clearLive();
    }
    if (this.preview?.source.failed === true) {
      this.fail('preview', this.preview.cue, 'failed to preview');
      this.preview = this.release(this.preview);
    }
  }

  /**
   * Point a slot at its cue's current definition, or report that the cue is
   * gone by returning null.
   *
   * Same decoder, new metadata, on purpose. Re-arming would build a second
   * source and start the clip from zero, so trimming a running cue's length
   * would also jump the floor back to its first frame — an edit doing visibly
   * more than it was asked to.
   *
   * Except when the media itself changed. The decoder is bound to a path, so
   * keeping it across a path change leaves the old clip on the floor under the
   * new cue's name, with nothing anywhere reporting a problem — it simply looks
   * like the wrong clip, which is the one kind of failure this project has no
   * channel for. Treated as a removal instead: the slot is torn down, and if it
   * was live the floor goes black until the operator fires the cue again.
   *
   * Unreachable from PR 2's UI, where every edit is add, move, delete, rename
   * or duration and `nextCueId` never reuses an id. PR 5 opens show files, and
   * that is where a cue's path changes underneath a running player.
   */
  private reseat(slot: Slot<S> | null): Slot<S> | null {
    if (slot === null) return null;
    const cue = this.cueById(slot.cue.id);
    if (cue === null || cue.source.path !== slot.cue.source.path) return null;
    if (cue.rotation !== slot.cue.rotation) slot.source.setRotation(cue.rotation);
    return { cue, source: slot.source };
  }

  private fail(surface: ErrorSurface, cue: Cue, reason: string): void {
    const error: SurfaceError = { cueId: cue.id, path: cue.source.path, reason };
    if (surface === 'live') this.liveError = error;
    else this.previewError = error;
  }

  /** Take down one surface's error. The other is not this one's to clear. */
  private resolve(surface: ErrorSurface): void {
    if (surface === 'live') this.liveError = null;
    else this.previewError = null;
  }

  /**
   * The one line the banner shows.
   *
   * Live wins when both surfaces have failed. Both are true and only one fits,
   * and the floor is the show — an operator reading "could not preview" while
   * the floor is dark has been told the less useful of two true things.
   */
  private get lastError(): string | null {
    const error = this.liveError ?? this.previewError;
    if (error === null) return null;
    // Named from the show as it is now, not as it was when this was recorded.
    // Renaming the cue that would not play is an ordinary thing to do with the
    // banner up, and the old name is one the operator can no longer find.
    const cue = this.cueById(error.cueId);
    return cue === null ? null : `cue ${JSON.stringify(cue.name)} ${error.reason}`;
  }

  /**
   * Drop an error whose cue is no longer in the show.
   *
   * The cue that would not decode is the one the operator deletes, and the
   * banner naming it then describes something that is not there — unactionable,
   * and up until the next successful GO, over a floor that may be perfectly
   * healthy. A channel that keeps talking after the fact is one that gets
   * ignored when it matters.
   */
  private retireStaleErrors(): void {
    const stale = (error: SurfaceError | null): boolean => {
      if (error === null) return false;
      const cue = this.cueById(error.cueId);
      // Deleted, or pointed at different media. Both are "the thing that failed
      // is not in the show any more", and both are what the operator does about
      // a clip that will not play: remove it, or swap a working one in.
      return cue === null || cue.source.path !== error.path;
    };
    if (stale(this.liveError)) this.liveError = null;
    if (stale(this.previewError)) this.previewError = null;
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

    // Standby is what fires next, and a timed cue is an automatic GO — but not
    // when Standby *is* the cue that is playing. Selecting a cue is how Standby
    // is armed, and selecting the live cue is exactly what an operator does to
    // edit its length in the inspector, so firing Standby here restarted the
    // running clip every N seconds for ever. Restarting on a timer is Loop, it
    // is PR 4, and it is not what a control labelled Duration promises. The cue
    // after the live one is what "the cue ends and the stack advances" means.
    const standby = this.cueById(this.standbyCueId);
    const next = standby !== null && standby.id === live.cue.id
      ? this.cueAfter(live.cue.id)
      : standby;

    if (next === null) {
      // End of the stack. Idle is black, and the send continues.
      this.clearLive();
      return;
    }

    // `arm` builds a decoder, and this is the only place it runs on the tick
    // path — which is the render loop. An exception escaping here skips that
    // frame's `writeFrame`, and because the duration stays expired it skips
    // every frame after it too, while `Sidecar` re-sends its last frame to a
    // floor nobody is driving any more. So a decoder that cannot be built is
    // black plus a banner, like every other failure, rather than a silent stall.
    try {
      this.pending = this.arm(next);
    } catch {
      this.fail('live', next, 'could not be started');
      // Going idle is also what stops this retrying: with no live cue there is
      // no duration left to expire, so the next tick does not try again.
      this.clearLive();
      return;
    }
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
