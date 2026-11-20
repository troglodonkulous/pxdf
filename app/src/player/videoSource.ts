import { openDecoder } from './decoderCensus'
import type { FrameSource, RecoveryEvent } from './engine'
import { mediaUrl } from './mediaUrl'
import { SourceReadiness } from './sourceReadiness'
import type { Rotation } from '../render/geometry'

export const RECOVERY_ATTEMPT_TIMEOUT_MS = 3_000
export const RECOVERY_EPISODE_DEADLINE_MS = 8_000
export const RECOVERY_MAX_ATTEMPTS = 3
export const RECOVERY_WINDOW_MS = 30_000

export type SnapshotSurface = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }

export interface VideoSourceOptions {
  createElement?(): HTMLVideoElement
  createCanvas?(): SnapshotSurface | null
  now?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

const defaults: Required<VideoSourceOptions> = {
  createElement: () => document.createElement('video'),
  createCanvas: () => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    return context === null ? null : { canvas, context }
  },
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface RecoveryEpisode {
  readonly start: number
  readonly originalError: string
  attempt: number
}

export interface DrawRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const EMPTY_RECT: DrawRect = { x: 0, y: 0, width: 0, height: 0 }

/** Centre-cropped cover-fit geometry for a source drawn into a destination. */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): DrawRect {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    !Number.isFinite(dstW) ||
    !Number.isFinite(dstH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    dstW <= 0 ||
    dstH <= 0
  ) {
    return EMPTY_RECT
  }

  const scale = Math.max(dstW / srcW, dstH / srcH)
  const width = srcW * scale
  const height = srcH * scale
  return {
    x: (dstW - width) / 2,
    y: (dstH - height) / 2,
    width,
    height,
  }
}

export function rotatedTargetSize(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height }
}

/**
 * Per-frame trim-wrap check. Units are milliseconds throughout.
 *
 * `outPointMs` is the cue's `trimEndMs ?? mediaDurationMs`, resolved by the
 * caller — an open `trimEndMs` means "play to the end of the media", not "never
 * wrap", and this function used to be handed the raw `trimEndMs` and return
 * `null` for it. That was the decoder half of a floor that never looped: the
 * only wrap in the app was gated on a field no UI can set, so every untrimmed
 * cue played once and froze on its last frame while the stack still advertised
 * `LOOP ∞`.
 *
 * `null` is now reserved for the one case that genuinely cannot wrap: an
 * out-point nobody knows yet, because the duration probe has not landed. A
 * source with no known length has no end to wrap at, and guessing one would put
 * a seek in the middle of a clip that was playing correctly.
 */
export function trimWrapPoint(currentTimeMs: number, trimStartMs: number, outPointMs: number | null): number | null {
  if (outPointMs === null) return null
  return currentTimeMs >= outPointMs ? trimStartMs : null
}

/**
 * `MediaError.code`, by name.
 *
 * Numbered by the HTML spec, not by us, and written out here because the
 * numbers alone are not a diagnosis: a banner reading `code 4` sends the
 * operator to a search engine, where `MEDIA_ERR_SRC_NOT_SUPPORTED` sends them
 * to the file. Both go in the message — the name for the reader, the number
 * because it is the value in every other account of the same failure.
 *
 * This is a plain table rather than `HTMLMediaElement.MEDIA_ERR_*` because the
 * constants live on the element's *interface object*, which does not exist in
 * the test environment (no jsdom, by `docs/APP-PLAN.md`); reading them here
 * would make the whole reason path ungradeable off-hardware, which is the state
 * that let this defect stand.
 */
const MEDIA_ERROR_NAMES: Readonly<Record<number, string>> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

/** The shape of `MediaError` this module reads. Kept structural so tests need no DOM. */
export interface MediaErrorLike {
  readonly code: number
  readonly message?: string
}

/**
 * What the element's own diagnosis says, as one line for the banner.
 *
 * In Chromium `MediaError.message` carries the real string —
 * `DEMUXER_ERROR_COULD_NOT_OPEN`, a decoder-init failure, the codec it choked
 * on — and it was thrown away wholesale before this: `onError` was
 * `(): void => { this.state.fail() }`, so every unplayable clip in the show
 * reached the operator as its own name and the word "failed".
 *
 * The `null` argument is not padding. `error` is genuinely null-typed on the
 * element, and an `error` event that arrives with nothing attached is a real
 * thing a source can do — reporting *that* is the point, because the
 * alternative is a failure with no reason at all, which is the case this
 * function exists to abolish.
 */
export function mediaErrorReason(error: MediaErrorLike | null | undefined): string {
  if (error === null || error === undefined) return 'media error with no MediaError attached'
  const name = MEDIA_ERROR_NAMES[error.code] ?? 'unknown media error'
  const message = error.message?.trim() ?? ''
  return message.length === 0 ? `${name} (code ${error.code})` : `${name} (code ${error.code}): ${message}`
}

/** One line naming a thrown value, for the failure paths that catch one. */
function thrownReason(prefix: string, error: unknown): string {
  if (error instanceof Error) {
    const detail = error.message.trim()
    return detail.length === 0 ? `${prefix}: ${error.name}` : `${prefix}: ${error.name}: ${detail}`
  }
  return `${prefix}: ${String(error)}`
}

/** A detached, muted video decoder that satisfies the player's frame-source contract. */
export class VideoSource implements FrameSource {
  private video: HTMLVideoElement
  private readonly options: Required<VideoSourceOptions>
  private readonly listeners: Array<[string, EventListener]> = []
  private episode: RecoveryEpisode | null = null
  private attemptStarts: number[] = []
  private timer: unknown = null
  private events: RecoveryEvent[] = []
  // undefined until a frame has actually been drawn, null if the surface is unavailable.
  private snapshot: SnapshotSurface | null | undefined
  private hasSnapshot = false
  private snapshotWarningReported = false
  /**
   * Mutable, unlike `path`. A decoder stays bound to its file for its whole
   * lifetime (see `PlayerEngine.reseat`'s "same decoder, new metadata"), but
   * rotation is presentation, not identity — the operator expects a live cue
   * to rotate in place, not restart, when they change it. `reseat` is what
   * calls `setRotation` on an already-playing source; the constructor value
   * below is only the rotation a freshly armed cue starts with.
   */
  private rotation: Rotation
  private readonly trimStartMs: number
  private readonly trimEndMs: number | null
  /** Ready / failed / disposed, and the ordering between them. */
  private readonly state = new SourceReadiness()
  /**
   * The census entry for this source's decoder, closed by `dispose`.
   *
   * Opened here and not at the `document.createElement` in the constructor's
   * default parameter, because what holds an element open is the source's
   * lifetime rather than who allocated it — and putting it in the default
   * would count only the sources that did not get one injected, which is every
   * source in the app and none in the tests. See `decoderCensus.ts`.
   */
  private readonly closeCensusEntry = openDecoder()
  private frameCallbackId: number | null = null
  /**
   * Whether the engine has told this source to stop, as opposed to the element
   * having stopped on its own.
   *
   * `HTMLMediaElement.paused` cannot answer that question: it is equally true
   * of a transport the operator paused, a clip sitting at EOF, and one that has
   * not been started yet. Restarting is only correct for the second, so the
   * distinction has to be held here — this tracks `pause()`/`play()`, which are
   * the engine's two words for its intent (`PlayerEngine.setPaused`, and
   * `arm`/`promotePending`).
   *
   * Both restart paths read it. Without it, PAUSE is not a pause: `compose`
   * keeps calling `draw` on a paused source every frame, so the wrap would seek
   * a held frame back to its in-point, and an `ended` already queued when the
   * engine paused would run afterwards and call `play()` — the floor resuming
   * under a PAUSE the operator pressed. `PlayerEngine.setPaused` promises the
   * opposite in as many words: the floor holds the paused frame.
   */
  private paused = false

  private readonly onError = (): void => {
    const error = this.video.error
    const reason = mediaErrorReason(error)
    if (error?.code !== 3 || !this.ready || this.failed || this.state.disposed) {
      this.fail(reason)
      return
    }

    // load() resets the old element's playhead and duration. Resolve the trim
    // here, while both still describe the clip that raised the error.
    const position = this.positionMs
    const resumeMs = trimWrapPoint(position, this.trimStartMs, this.trimEndMs ?? this.mediaDurationMs) ?? position
    this.episode ??= { start: this.options.now(), originalError: reason, attempt: 0 }
    this.startAttempt(this.episode, resumeMs)
  }

  // The mid-run channel, and the only one the element gives us for it.
  //
  // `stalled` and `waiting` are the element saying it has run out of data, and
  // they are two different conditions rather than one with two names: `waiting`
  // is playback actually halted, `stalled` is the fetch having gone quiet for a
  // couple of seconds while playback may still be running off what is already
  // buffered. Neither is terminal — a clip that buffers and recovers fires
  // `waiting` then `playing` — so they set a condition rather than failing the
  // source, and each is cleared by its own counterpart below.
  //
  // Deliberately the element's events and not a position-stall timer. A timer
  // watching `currentTime` for movement has to pick a threshold, and every
  // threshold is wrong somewhere: too tight and a single long frame or a
  // paused transport reads as a stall, too loose and it reports the buffering
  // after the operator has already seen it. `CLAUDE.md` names that exact shape
  // — "a channel that cries wolf is a destroyed channel". The element knows
  // whether it is waiting for bytes; nothing here has to guess.
  private readonly onStalled = (event: Event): void => {
    this.state.stall('fetch', `clip is buffering (${event.type})`)
  }

  private readonly onWaiting = (event: Event): void => {
    this.state.stall('playback', `clip is buffering (${event.type})`)
  }

  // `playing` is the resume after a `waiting`; `canplay` is the element saying
  // it has enough data to play again, which is the resume for a source that
  // halted while paused or pre-roll and for which `playing` never fires.
  private readonly onResumed = (): void => {
    this.state.clearStall('playback')
  }

  // The end of a `stalled`, and the only event that is.
  //
  // A fetch that goes quiet and then resumes need not cross any playback
  // threshold at all: if the element kept playing from its buffer throughout,
  // `playing` never fires and `readyState` never falls far enough for `canplay`
  // to fire again either. Cleared only by `playing`/`canplay`, that warning
  // stays up for the rest of the show over a clip that recovered in three
  // seconds — a stale warning outliving its condition, which is the specific
  // way this project's channels die.
  private readonly onProgress = (): void => {
    this.state.clearStall('fetch')
  }

  // Readiness has two independent signals on purpose, and neither gates the
  // other. `requestVideoFrameCallback` is the precise one — it fires when a
  // frame has actually been presented — but these elements are deliberately
  // detached from the document, and a detached element may never present a
  // frame to a compositor that is not drawing it. Gating the media events
  // behind "rVFC exists" would therefore make `ready` depend on an rVFC that
  // may never fire in exactly the configuration this app uses, and a source
  // that never reports ready is a cue that never goes live: GO would appear to
  // do nothing, for ever, with no error anywhere.
  //
  // (Measured 2026-09-29 in this Electron: rVFC does fire on these detached
  // elements, ~30 a second on a 30 fps clip, and keeping one registered
  // changes how Chromium hands them frames — see `requestDecodedFrame`. That
  // is one Chromium, not a guarantee, so readiness still does not depend on it.)
  //
  // Both signals land in `markReadyFromElement`, which owns the threshold.
  private readonly onData = (): void => {
    this.markReadyFromElement()
  }

  // The restart, and the reason `video.loop` stays false.
  //
  // Native looping restarts at zero and ignores an out-point, so it is wrong
  // for every cue this app can author: a clip trimmed to start at 1,200 ms
  // would loop back to the head the operator trimmed off. The wrap in `draw`
  // seeks to the in-point instead, and this listener is the same seek driven
  // off the element's own end-of-stream.
  //
  // Both, not either. `draw`'s check is a comparison against `currentTime`, and
  // the element is entitled to pause itself at EOF before that comparison ever
  // reads a time at or past the out-point — `currentTime` can settle a frame
  // short of `duration` and simply stop moving, which is a wrap check that
  // never fires and a floor frozen on the last frame. `ended` is the element
  // stating the case outright. `draw`'s check is what handles the case `ended`
  // cannot see: a bounded `trimEndMs` in the middle of the media, where
  // playback never reaches the end of the stream at all.
  //
  // `failed` and not `failed || disposed`, deliberately. `dispose` removes this
  // listener, so a disposed source cannot reach here at all and a `disposed`
  // check would be a branch no test could ever turn red — the teardown in
  // `dispose` is what grades that case. A *failed* source is reachable: the
  // element that raised `error` keeps its listeners and can still hit EOF, and
  // seeking a source the operator already has a banner about would move the
  // playhead of a cue nothing is showing.
  private readonly onEnded = (): void => {
    if (this.state.failed || this.paused || this.episode !== null) return
    this.video.currentTime = this.trimStartMs / 1_000
    this.play()
  }

  /**
   * @param element the decoder to drive, defaulting to a fresh detached one.
   *        Injected only by tests: everything below this line — which
   *        `MediaError` code produces which sentence, that a `stalled` is not a
   *        failure, that a failure after a stall replaces it — is element
   *        behaviour, and with no jsdom in this project (`docs/APP-PLAN.md`,
   *        "no third harness") the only alternative to a seam here is grading
   *        it on hardware, which is where it went ungraded in the first place.
   */
  constructor(
    private readonly path: string,
    rotation: Rotation = 0,
    trim: { trimStartMs: number; trimEndMs: number | null } = { trimStartMs: 0, trimEndMs: null },
    element: HTMLVideoElement = document.createElement('video'),
    options: VideoSourceOptions = {},
  ) {
    this.rotation = rotation
    this.trimStartMs = trim.trimStartMs
    this.trimEndMs = trim.trimEndMs
    this.video = element
    this.options = { ...defaults, ...options }
    try {
      this.loadElement(this.trimStartMs)
    } catch (error) {
      this.fail(thrownReason('could not start loading the media', error))
    }
  }

  private listen(type: string, handle: EventListener): void {
    const element = this.video
    const listener: EventListener = (event) => {
      if (element === this.video && !this.state.disposed) handle(event)
    }
    element.addEventListener(type, listener)
    this.listeners.push([type, listener])
  }

  private loadElement(positionMs: number): void {
    this.video.muted = true
    this.video.playsInline = true
    // Deliberately false, and not the obvious way to make a clip loop. See
    // `onEnded`: the element's own loop restarts at zero and has no notion of
    // an in-point, so it would replay the head of every trimmed cue.
    this.video.loop = false
    this.video.preload = 'auto'
    this.listen('error', this.onError)
    this.listen('ended', this.onEnded)
    this.listen('loadeddata', this.onData)
    this.listen('canplay', this.onData)
    this.listen('seeked', this.onData)
    this.listen('stalled', this.onStalled)
    this.listen('waiting', this.onWaiting)
    this.listen('progress', this.onProgress)
    this.listen('playing', this.onResumed)
    this.listen('canplay', this.onResumed)

    if (this.path.trim().length === 0) {
      this.fail('no media path on this cue')
      return
    }

    // Before `src`, not after: the request mode is fixed when the load
    // starts, and setting `crossOrigin` afterwards would apply to the next
    // load rather than this one. Every reload element needs it too, or the
    // replacement taints the shared work canvas.
    //
    // This is not optional and it is not hygiene. `pxdf-media://` is a
    // different origin from the page however the page was served, so without
    // a CORS-mode fetch the media taints any canvas it is drawn into and the
    // render loop's `getImageData` throws on every frame — see the long note
    // in `electron/main.ts`. It only works paired with `corsEnabled` on the
    // scheme; alone it makes the element fail to load at all.
    this.video.crossOrigin = 'anonymous'
    // Never `file://`. The page is served over `file://` when packaged and
    // over `http://` under the dev server, and Chromium blocks a `file://`
    // subresource from the second — see `mediaUrl.ts`.
    this.video.src = mediaUrl(this.path)
    this.video.load()
    if (positionMs > 0) this.video.currentTime = positionMs / 1_000
    this.requestDecodedFrame()
  }

  get ready(): boolean {
    return this.state.ready
  }

  get drawable(): boolean {
    return this.ready && !this.failed && !this.state.disposed && this.episode === null
  }

  takeRecoveryEvents(): RecoveryEvent[] {
    const events = this.events
    this.events = []
    return events
  }

  get failed(): boolean {
    return this.state.failed
  }

  get failureReason(): string | null {
    return this.state.failureReason
  }

  get stallReason(): string | null {
    return this.episode === null ? this.state.stallReason : 'is recovering from a decode error'
  }

  /**
   * Mark the media unplayable from outside the element.
   *
   * `draw` only sees the failures `drawImage` itself raises, and the step after
   * it — reading the composited pixels back off the work canvas — fails for
   * reasons that belong to this source just as much. A tainted canvas is a
   * property of what was drawn into it.
   *
   * The engine has exactly one channel for that news, `failed`, and it does the
   * right things with it: an error the operator can read, and black on the
   * floor rather than a held frame of a cue that is broken. Without this seam
   * the render loop rediscovers the same dead source sixty times a second for
   * ever, with nothing on screen to say so — which is precisely how the taint
   * defect stayed invisible.
   *
   * The reason is the caller's because the caller is the only one who has it.
   * `composeFrame` catches a `SecurityError` off `getImageData`, and that
   * string is the diagnosis — a tainted canvas and a decoder that died are the
   * same `failed` flag from here, and telling them apart is the difference
   * between suspecting the clip and suspecting `corsEnabled`.
   */
  fail(reason: string): void {
    this.endEpisode()
    this.state.fail(reason)
  }

  private clearAttemptTimer(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer)
    this.timer = null
  }

  private endEpisode(): void {
    this.clearAttemptTimer()
    this.episode = null
  }

  private recordRecovery(kind: RecoveryEvent['kind'], episode: RecoveryEpisode): void {
    this.events.push({
      kind,
      attempt: episode.attempt,
      elapsedMs: this.options.now() - episode.start,
      originalError: episode.originalError,
    })
  }

  private startAttempt(episode: RecoveryEpisode, resumeMs: number): void {
    this.clearAttemptTimer()
    const now = this.options.now()
    const deadline = episode.start + RECOVERY_EPISODE_DEADLINE_MS
    this.attemptStarts = this.attemptStarts.filter((start) => now - start < RECOVERY_WINDOW_MS)
    if (now >= deadline || this.attemptStarts.length >= RECOVERY_MAX_ATTEMPTS) {
      this.fail(episode.originalError)
      return
    }

    this.attemptStarts.push(now)
    episode.attempt++
    try {
      this.releaseElement()
      this.video = this.options.createElement()
      this.loadElement(resumeMs)
      // Started now, not at completion, when the transport is running. Every
      // element this app has ever put on the floor was `play()`ed straight
      // after `load()` (`PlayerEngine.arm`), and that is the only path any
      // floor has exercised. Waiting for a paused, detached, `preload=auto`
      // element to decode a first frame on its own is a different Chromium
      // path that nothing here has measured; if it never fires `loadeddata`,
      // every recovery times out and the floor holds a frozen frame for 8 s
      // before going black — worse than no recovery at all.
      if (!this.paused) this.startPlayback()
      this.recordRecovery('attempt', episode)

      // One wakeup serves both bounds. The final attempt gets only the time
      // left in this episode, even if a previous timeout itself arrived late.
      const element = this.video
      const remaining = Math.min(now + RECOVERY_ATTEMPT_TIMEOUT_MS, deadline) - this.options.now()
      this.timer = this.options.setTimer(() => {
        if (this.episode === episode && this.video === element) this.startAttempt(episode, resumeMs)
      }, Math.max(0, remaining))
    } catch (error) {
      this.fail(thrownReason(`${episode.originalError} — could not reload the media`, error))
    }
  }

  /** Called by `PlayerEngine.reseat` when the cue's rotation changes under an already-armed source. */
  setRotation(rotation: Rotation): void {
    this.rotation = rotation
  }

  get positionMs(): number {
    const seconds = this.video.currentTime
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0
  }

  get mediaDurationMs(): number | null {
    const seconds = this.video.duration
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null
  }

  play(): void {
    if (this.state.disposed || this.state.failed) return
    this.paused = false
    // During a reload the replacement has only just been seeked to the resume
    // point and has no duration yet, so the wrap below has nothing to judge;
    // it runs again from `markReadyFromElement` once the attempt has a frame.
    if (this.episode !== null) {
      this.startPlayback()
      return
    }
    // Before `video.play()`, and this ordering is the whole point.
    //
    // The element parks at EOF whenever the transport paused there — the guard
    // in `onEnded` deliberately leaves it parked rather than restarting under a
    // PAUSE — and the HTML `play()` algorithm says that starting playback from
    // the end of the media "seek[s] to the earliest possible position" first,
    // which is zero and not this cue's in-point. So RESUME on a trimmed cue
    // paused at its end would restart it at the media head, showing the operator
    // exactly the footage the trim exists to remove, for a whole lap, with
    // nothing else able to correct it: `draw`'s wrap sees a playhead at 0, which
    // is nowhere near the out-point, and `ended` will not fire again until the
    // clip has played all the way through the head it should never have shown.
    //
    // Seeking first makes the element's own rule inapplicable — the playback
    // position is no longer the end of the resource — rather than racing it.
    this.wrapIfSpent()
    this.startPlayback()
  }

  /**
   * Hand control to the current element, ignoring a rejection that belongs to
   * an element since replaced by a reload — that promise is about a decoder
   * this source no longer has.
   */
  private startPlayback(): void {
    const element = this.video
    void element.play().catch((error: unknown) => {
      // An `AbortError` means a newer load or pause superseded this play, which
      // is ordinary during a cue change and not a failure. `state.fail()`
      // ignores everything after teardown on its own.
      if (element !== this.video || (error instanceof DOMException && error.name === 'AbortError')) return
      this.fail(thrownReason('playback was refused', error))
    })
  }

  pause(): void {
    // Set before the disposed guard, and unconditionally: a source nobody is
    // going to play again is the last one that should be able to restart itself.
    // Reaches the element during a reload too, because the reload started it.
    this.paused = true
    if (!this.state.disposed) this.video.pause()
  }

  dispose(): void {
    if (!this.state.dispose()) return
    // First, and unconditionally past the idempotence guard above: everything
    // below this line can in principle throw on a hostile element, and a census
    // that stops decrementing the moment something else goes wrong would report
    // an exhaustion that never happened.
    this.closeCensusEntry()
    this.endEpisode()
    this.events = []
    this.snapshot = null
    this.hasSnapshot = false
    this.releaseElement()
  }

  private releaseElement(): void {
    if (this.frameCallbackId !== null && this.hasVideoFrameCallbacks()) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId)
      this.frameCallbackId = null
    }
    for (const [type, listener] of this.listeners) this.video.removeEventListener(type, listener)
    this.listeners.length = 0
    // A new element has its own fetch and playback conditions. The old
    // element can no longer deliver the progress event that cleared its stall.
    this.state.clearStall('fetch')
    this.state.clearStall('playback')
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
    context.fillStyle = '#000000'
    context.fillRect(0, 0, width, height)

    // Live and preview share this work context. Both paths repaint it from
    // black, including a reload before the source ever had a frame drawn.
    if (this.drawable) {
      // Gated on the transport and nothing else. The out-point of an untrimmed
      // cue is the media's own length, not "there isn't one" — gating this on
      // `trimEndMs !== null`, as it was, meant the only clips that could ever
      // wrap were the ones no UI in this app can author.
      //
      // `draw` runs while the transport is paused: `compose` composites the
      // live source every frame regardless, which is what keeps a *sent* frame
      // on the floor rather than stopping the send. So the wrap has to check —
      // a clip paused at or past its out-point would otherwise be seeked back
      // to its in-point by the very next composite, and PAUSE would jump the
      // floor instead of holding it.
      if (!this.paused) this.wrapIfSpent()
      const rect = this.paintFrame(context, width, height, this.video, this.video.videoWidth, this.video.videoHeight)
      if (rect !== null) this.captureSnapshot(rect)
    } else if (this.episode !== null && this.hasSnapshot && this.snapshot) {
      const { canvas } = this.snapshot
      this.paintFrame(context, width, height, canvas, canvas.width, canvas.height)
    }
    context.restore()
  }

  private paintFrame(
    context: CanvasRenderingContext2D, width: number, height: number,
    image: CanvasImageSource, srcW: number, srcH: number,
  ): DrawRect | null {
    const target = rotatedTargetSize(width, height, this.rotation)
    const rect = coverRect(srcW, srcH, target.width, target.height)
    if (rect.width === 0 || rect.height === 0) return null
    context.translate(width / 2, height / 2)
    context.rotate((this.rotation * Math.PI) / 180)
    try {
      context.drawImage(image, rect.x - target.width / 2, rect.y - target.height / 2, rect.width, rect.height)
      return rect
    } catch (error) {
      this.fail(thrownReason('the decoded frame could not be drawn', error))
      return null
    }
  }

  private captureSnapshot(rect: DrawRect): void {
    try {
      if (this.snapshot === undefined) {
        // Remember even a failed allocation. Repeating it every render tick
        // would spend the frame budget on a surface the renderer cannot supply.
        this.snapshot = null
        this.snapshot = this.options.createCanvas()
      }
      if (this.snapshot === null) return
      const { canvas, context } = this.snapshot
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      // Resizing clears a canvas, even when assigned its existing size.
      if (canvas.width !== w || canvas.height !== h) {
        this.hasSnapshot = false
        canvas.width = w
        canvas.height = h
      }
      // A transparent pixel in this frame must replace the previous pixel.
      // The black backing is applied on the work canvas when the hold is drawn.
      context.globalCompositeOperation = 'copy'
      context.drawImage(this.video, 0, 0, w, h)
      this.hasSnapshot = true
    } catch (error) {
      // The work canvas already has its frame. Preserve a previous copy if
      // it survived resizing, and keep an optional hold from killing playback.
      if (!this.snapshotWarningReported) console.warn('Could not capture player recovery frame', error)
      this.snapshotWarningReported = true
    }
  }

  /**
   * Put the playhead back at the in-point if it is at or past the out-point.
   *
   * The single definition of where this clip restarts, and idempotent, so every
   * caller can run it without checking first. Three of them now: `draw` once a
   * rendered frame, `play` before handing control back to the element, and
   * `onEnded` by way of `play`. Each has a different trigger and none of them
   * subsumes the others, but they must all agree on the answer — a second
   * restart position expressed anywhere is a trimmed cue that plays its own
   * head on one path and not another.
   */
  private wrapIfSpent(): void {
    const wrapToMs = trimWrapPoint(
      this.video.currentTime * 1_000,
      this.trimStartMs,
      this.trimEndMs ?? this.mediaDurationMs,
    )
    if (wrapToMs !== null) this.video.currentTime = wrapToMs / 1_000
  }

  private hasVideoFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function'
  }

  /**
   * One frame callback at a time, for the life of the source — not only until
   * it is ready, which was all this used to be for.
   *
   * ## Why it stays armed
   *
   * Keeping a callback registered is what puts this element's frames on the
   * floor at an even cadence. These elements are detached, and without a
   * callback Chromium hands the element new frames on a clock of its own; the
   * render loop samples it every other vsync, and where the two sit close,
   * rAF jitter decides which side of a frame change a compose lands on — one
   * frame composed twice and the next never. With a callback armed, the same
   * renderer composed every frame once. Measured with
   * `test/e2e/probe-render-rate.mjs`'s renderer trace under `--pacing
   * arrival` at 30-on-30 (`captures/measurements/README.md`,
   * render-rate-video-frames-2026-09-29): 2.29-3.58 % of composes off-pattern
   * with the chain stopping at ready, 0.00-0.18 % with it kept.
   *
   * That is an observed Chromium behaviour, not a documented one — which is
   * why the test that keeps this armed names the measurement, and why the
   * probe should be re-run on an Electron upgrade. Composing *on* the
   * callback (gating the render loop on `presentedFrames`) was built and
   * graded too, and measured no better than this alone (same entry).
   *
   * Releasing the element ends its chain. A replacement arms its own.
   */
  private requestDecodedFrame(): void {
    if (!this.hasVideoFrameCallbacks() || this.state.disposed) return
    const element = this.video
    this.frameCallbackId = element.requestVideoFrameCallback(() => {
      if (element !== this.video || this.state.disposed) return
      this.frameCallbackId = null
      this.markReadyFromElement()
      this.requestDecodedFrame()
    })
  }

  /**
   * The one DOM read behind readiness, kept here rather than in
   * `SourceReadiness` so the threshold sits next to the constant that defines
   * it. `HAVE_CURRENT_DATA` means there is decoded data for the current
   * position, which is exactly what `draw` needs — the floor, not the ceiling.
   */
  private markReadyFromElement(): void {
    if (!this.state.observe(this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)) return
    const episode = this.episode
    if (episode === null) return
    // A throttled timer can still be queued when a media event is dispatched.
    // Check the actual clock before claiming the episode recovered in time.
    if (this.options.now() - episode.start >= RECOVERY_EPISODE_DEADLINE_MS) {
      this.fail(episode.originalError)
      return
    }
    this.recordRecovery('recovered', episode)
    this.endEpisode()
    this.state.clearStall('fetch')
    this.state.clearStall('playback')
    if (this.paused) this.video.pause()
    else this.play()
  }
}
