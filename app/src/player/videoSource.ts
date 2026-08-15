import type { FrameSource } from './engine'
import { mediaUrl } from './mediaUrl'
import { SourceReadiness } from './sourceReadiness'
import type { Rotation } from '../render/geometry'

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
  private readonly video: HTMLVideoElement
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
    this.state.fail(mediaErrorReason(this.video.error))
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
    if (this.state.failed || this.paused) return
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
    path: string,
    rotation: Rotation = 0,
    trim: { trimStartMs: number; trimEndMs: number | null } = { trimStartMs: 0, trimEndMs: null },
    element: HTMLVideoElement = document.createElement('video'),
  ) {
    this.rotation = rotation
    this.trimStartMs = trim.trimStartMs
    this.trimEndMs = trim.trimEndMs
    this.video = element
    this.video.muted = true
    this.video.playsInline = true
    // Deliberately false, and not the obvious way to make a clip loop. See
    // `onEnded`: the element's own loop restarts at zero and has no notion of
    // an in-point, so it would replay the head of every trimmed cue.
    this.video.loop = false
    this.video.preload = 'auto'
    this.video.addEventListener('error', this.onError)
    this.video.addEventListener('ended', this.onEnded)
    this.video.addEventListener('loadeddata', this.onData)
    this.video.addEventListener('canplay', this.onData)
    this.video.addEventListener('stalled', this.onStalled)
    this.video.addEventListener('waiting', this.onWaiting)
    this.video.addEventListener('progress', this.onProgress)
    this.video.addEventListener('playing', this.onResumed)
    this.video.addEventListener('canplay', this.onResumed)

    if (path.trim().length === 0) {
      this.state.fail('no media path on this cue')
      return
    }

    try {
      // Before `src`, not after: the request mode is fixed when the load
      // starts, and setting `crossOrigin` afterwards would apply to the next
      // load rather than this one.
      //
      // This is not optional and it is not hygiene. `ddf-media://` is a
      // different origin from the page however the page was served, so without
      // a CORS-mode fetch the media taints any canvas it is drawn into and the
      // render loop's `getImageData` throws on every frame — see the long note
      // in `electron/main.ts`. It only works paired with `corsEnabled` on the
      // scheme; alone it makes the element fail to load at all.
      this.video.crossOrigin = 'anonymous'
      // Never `file://`. The page is served over `file://` when packaged and
      // over `http://` under the dev server, and Chromium blocks a `file://`
      // subresource from the second — see `mediaUrl.ts`.
      this.video.src = mediaUrl(path)
      this.video.load()
      if (trim.trimStartMs > 0) this.video.currentTime = trim.trimStartMs / 1_000
      this.requestDecodedFrame()
    } catch (error) {
      this.state.fail(thrownReason('could not start loading the media', error))
    }
  }

  get ready(): boolean {
    return this.state.ready
  }

  get failed(): boolean {
    return this.state.failed
  }

  get failureReason(): string | null {
    return this.state.failureReason
  }

  get stallReason(): string | null {
    return this.state.stallReason
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
    this.state.fail(reason)
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
    void this.video.play().catch((error: unknown) => {
      // An `AbortError` means a newer load or pause superseded this play, which
      // is ordinary during a cue change and not a failure. `state.fail()`
      // ignores everything after teardown on its own.
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.state.fail(thrownReason('playback was refused', error))
    })
  }

  pause(): void {
    // Set before the disposed guard, and unconditionally: a source nobody is
    // going to play again is the last one that should be able to restart itself.
    this.paused = true
    if (!this.state.disposed) this.video.pause()
  }

  dispose(): void {
    if (!this.state.dispose()) return

    if (this.frameCallbackId !== null && this.hasVideoFrameCallbacks()) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId)
      this.frameCallbackId = null
    }
    this.video.removeEventListener('error', this.onError)
    this.video.removeEventListener('ended', this.onEnded)
    this.video.removeEventListener('loadeddata', this.onData)
    this.video.removeEventListener('canplay', this.onData)
    this.video.removeEventListener('stalled', this.onStalled)
    this.video.removeEventListener('waiting', this.onWaiting)
    this.video.removeEventListener('progress', this.onProgress)
    this.video.removeEventListener('playing', this.onResumed)
    this.video.removeEventListener('canplay', this.onResumed)
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

    if (this.state.ready && !this.state.failed) {
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
      if (!this.paused) {
        const wrapToMs = trimWrapPoint(
          this.video.currentTime * 1_000,
          this.trimStartMs,
          this.trimEndMs ?? this.mediaDurationMs,
        )
        if (wrapToMs !== null) this.video.currentTime = wrapToMs / 1_000
      }
      const target = rotatedTargetSize(width, height, this.rotation)
      const rect = coverRect(this.video.videoWidth, this.video.videoHeight, target.width, target.height)
      if (rect.width > 0 && rect.height > 0) {
        context.save()
        context.translate(width / 2, height / 2)
        context.rotate((this.rotation * Math.PI) / 180)
        try {
          context.drawImage(
            this.video,
            rect.x - target.width / 2,
            rect.y - target.height / 2,
            rect.width,
            rect.height,
          )
        } catch (error) {
          this.state.fail(thrownReason('the decoded frame could not be drawn', error))
        }
        context.restore()
      }
    }
    context.restore()
  }

  private hasVideoFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function'
  }

  private requestDecodedFrame(): void {
    if (!this.hasVideoFrameCallbacks() || this.state.disposed) return
    this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
      this.frameCallbackId = null
      if (!this.markReadyFromElement()) this.requestDecodedFrame()
    })
  }

  /**
   * The one DOM read behind readiness, kept here rather than in
   * `SourceReadiness` so the threshold sits next to the constant that defines
   * it. `HAVE_CURRENT_DATA` means there is decoded data for the current
   * position, which is exactly what `draw` needs — the floor, not the ceiling.
   */
  private markReadyFromElement(): boolean {
    return this.state.observe(this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
  }
}
