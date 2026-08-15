import { beforeAll, describe, expect, it } from 'vitest'
import { coverRect, mediaErrorReason, rotatedTargetSize, trimWrapPoint, VideoSource } from '../src/player/videoSource'
import { PlayerEngine } from '../src/player/engine'
import { SHOW_FILE_VERSION, type Cue, type Show } from '../src/player/show'

describe('coverRect', () => {
  it('centre-crops a source that is wider than the box', () => {
    const rect = coverRect(1_920, 1_080, 80, 80)
    expect(rect.x).toBeCloseTo(-31.111_111)
    expect(rect.y).toBe(0)
    expect(rect.width).toBeCloseTo(142.222_222)
    expect(rect.height).toBe(80)
  })

  it('centre-crops a source that is taller than the box', () => {
    const rect = coverRect(1_080, 1_920, 80, 40)
    expect(rect.x).toBe(0)
    expect(rect.y).toBeCloseTo(-51.111_111)
    expect(rect.width).toBe(80)
    expect(rect.height).toBeCloseTo(142.222_222)
  })

  it('fits an exact aspect match without cropping', () => {
    expect(coverRect(160, 80, 80, 40)).toEqual({ x: 0, y: 0, width: 80, height: 40 })
  })

  it.each([
    [0, 1_080],
    [Number.NaN, 1_080],
  ])('returns a finite empty rect for an unavailable %s x %s source', (width, height) => {
    const rect = coverRect(width, height, 80, 40)
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(Object.values(rect).every(Number.isFinite)).toBe(true)
  })
})

/**
 * The target `VideoSource.draw` cover-fits a cue's video against, before
 * rotating the drawn result into place. Swapping width/height at 90/270
 * mirrors `render/geometry.ts`'s `canvasSize` — a cue authored 80 x 40 and
 * rotated 90 degrees has to cover-fit into a 40 x 80 target, or a landscape
 * clip gets cropped as if it were already portrait.
 */
describe('rotatedTargetSize', () => {
  it('leaves the target alone at 0 and 180', () => {
    expect(rotatedTargetSize(80, 40, 0)).toEqual({ width: 80, height: 40 })
    expect(rotatedTargetSize(80, 40, 180)).toEqual({ width: 80, height: 40 })
  })

  it('swaps width and height at 90 and 270', () => {
    expect(rotatedTargetSize(80, 40, 90)).toEqual({ width: 40, height: 80 })
    expect(rotatedTargetSize(80, 40, 270)).toEqual({ width: 40, height: 80 })
  })
})

/**
 * The trim-wrap check, as a pure function so it is gradeable under `vitest`
 * without a DOM (`docs/APP-PLAN.md`, "no jsdom, no third harness" — a real
 * `HTMLVideoElement` is graded only by `wire.mjs`).
 *
 * `VideoSource.draw` calls this on every drawn frame, never on `timeupdate` —
 * that event fires roughly every 250 ms, and by the time it fired the floor
 * would already be showing content past the cue's out-point. `draw` runs once
 * per `requestAnimationFrame`, which is what "per-frame" means here.
 *
 * Units are milliseconds throughout, matching `Cue.trimStartMs`/`trimEndMs`;
 * `VideoSource` converts `HTMLVideoElement.currentTime` (seconds) at the call
 * site so this function stays free of that unit conversion.
 */
describe('trimWrapPoint', () => {
  it('never wraps when the out-point is unknown (the duration probe has not landed)', () => {
    expect(trimWrapPoint(0, 0, null)).toBe(null)
    expect(trimWrapPoint(999_999, 1_000, null)).toBe(null)
  })

  /**
   * The case the whole loop defect lived in. An untrimmed cue's out-point is
   * the media's own length, and `VideoSource.draw` resolves it as
   * `trimEndMs ?? mediaDurationMs` — so `null` here means "no length known",
   * never "plays for ever". Passing the raw `trimEndMs` instead is the exact
   * shape of the bug: every cue in the app has an open `trimEndMs` (no UI sets
   * one), so no cue could ever wrap.
   */
  it('wraps at the media duration when the cue has no out-point of its own', () => {
    expect(trimWrapPoint(2_999, 0, 3_000)).toBe(null)
    expect(trimWrapPoint(3_000, 0, 3_000)).toBe(0)
    expect(trimWrapPoint(3_000, 1_200, 3_000)).toBe(1_200)
  })

  it('does not wrap before the out-point', () => {
    expect(trimWrapPoint(4_999, 1_000, 5_000)).toBe(null)
  })

  it('wraps to trimStart exactly at the out-point', () => {
    expect(trimWrapPoint(5_000, 1_000, 5_000)).toBe(1_000)
  })

  it('wraps to trimStart once playback has passed the out-point', () => {
    // A dropped frame or a slow tab can land past the boundary rather than on
    // it; the check still has to fire, not wait for an exact match.
    expect(trimWrapPoint(5_250, 1_000, 5_000)).toBe(1_000)
  })

  it('wraps to a non-zero in-point, not to zero', () => {
    expect(trimWrapPoint(5_000, 1_200, 5_000)).toBe(1_200)
  })
})

/**
 * The element's own diagnosis, and the road it now travels to the operator.
 *
 * ## What was wrong
 *
 * `VideoSource`'s handler was `onError = (): void => { this.state.fail() }`.
 * `video.error` — a `MediaError` carrying a code and, in Chromium, a real
 * string such as `DEMUXER_ERROR_COULD_NOT_OPEN` — was read by nobody and
 * discarded. Every unplayable clip in a show therefore reached the banner as
 * the same sentence: the cue's name and a verb. A file with an unsupported
 * codec, a file that is not there, a decoder that ran out of memory under load
 * and a canvas the compositor could not read back were one message.
 *
 * ## Why it is graded here, against a fake element
 *
 * This project has two harnesses and refuses a third (`docs/APP-PLAN.md`), so
 * there is no jsdom and `VideoSource` had no unit coverage at all — only its
 * three pure functions above did. That is exactly why the defect stood: the one
 * line that mattered was in the half of the file nothing could reach. A source
 * that cannot be driven from a test is a source whose error path is graded by
 * running a show.
 *
 * The seam is `VideoSource`'s fourth constructor parameter, and the fake below
 * is the smallest object the class actually touches. Note what it does *not*
 * have: `requestVideoFrameCallback`. Its absence is deliberate and matches the
 * real risk — the class already has to work on an element that never presents
 * a frame, and the readiness comment in `videoSource.ts` explains why.
 */

/**
 * `HTMLMediaElement` is an interface object that only a DOM provides, and
 * `markReadyFromElement` reads `HAVE_CURRENT_DATA` off it. Supplying the
 * spec's value is test-environment setup of the same kind as the fake element
 * itself; the constant is fixed by the HTML standard, not by this app.
 */
beforeAll(() => {
  const globals = globalThis as unknown as { HTMLMediaElement?: unknown }
  globals.HTMLMediaElement ??= { HAVE_CURRENT_DATA: 2 }
})

interface FakeMediaError {
  readonly code: number
  readonly message: string
}

/** The part of an `HTMLVideoElement` `VideoSource` uses, and nothing else. */
class FakeVideoElement {
  muted = false
  playsInline = false
  loop = true
  preload = ''
  crossOrigin: string | null = null
  src = ''
  currentTime = 0
  duration = Number.NaN
  readyState = 0
  videoWidth = 0
  videoHeight = 0
  error: FakeMediaError | null = null
  loadCalls = 0
  pauseCalls = 0
  playCalls = 0

  /** Set to make `play()` reject, as a real element's does under an autoplay or load abort. */
  playRejectsWith: unknown = null

  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, handler: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  load(): void {
    this.loadCalls += 1
  }

  pause(): void {
    this.pauseCalls += 1
  }

  removeAttribute(): void {
    this.src = ''
  }

  async play(): Promise<void> {
    this.playCalls += 1
    if (this.playRejectsWith !== null) throw this.playRejectsWith
  }

  /** Fire one of the element's events at whatever `VideoSource` registered for it. */
  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ type } as Event)
  }

  /** How many handlers are still attached, for the teardown check. */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

function sourceOver(element: FakeVideoElement, path = '/media/clip.mp4'): VideoSource {
  return new VideoSource(path, 0, { trimStartMs: 0, trimEndMs: null }, element as unknown as HTMLVideoElement)
}

/**
 * Every `MediaError` code the HTML spec defines, with the Chromium message
 * shape each one arrives with in this app.
 *
 * All four, not a representative one: the codes are a `Record` lookup, and a
 * lookup is precisely the thing that is right for the case someone thought
 * about and wrong for the others.
 */
const MEDIA_ERRORS: ReadonlyArray<readonly [FakeMediaError, string, string]> = [
  [{ code: 1, message: 'load aborted' }, 'MEDIA_ERR_ABORTED', 'load aborted'],
  [{ code: 2, message: 'NETWORK_ERROR' }, 'MEDIA_ERR_NETWORK', 'NETWORK_ERROR'],
  [{ code: 3, message: 'DECODER_ERROR_NOT_SUPPORTED' }, 'MEDIA_ERR_DECODE', 'DECODER_ERROR_NOT_SUPPORTED'],
  [{ code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }, 'MEDIA_ERR_SRC_NOT_SUPPORTED', 'DEMUXER_ERROR_COULD_NOT_OPEN'],
]

describe('mediaErrorReason', () => {
  it.each(MEDIA_ERRORS)('names the code and carries the message for %o', (error, name, message) => {
    const reason = mediaErrorReason(error)
    expect(reason).toContain(name)
    expect(reason).toContain(`code ${error.code}`)
    expect(reason).toContain(message)
  })

  it('still names the code when the element supplies no message', () => {
    // Not every failure carries a string, and a reason that was only ever the
    // message would be empty for those — a failure with no account of itself,
    // which is the state this whole change exists to end.
    expect(mediaErrorReason({ code: 3, message: '' })).toBe('MEDIA_ERR_DECODE (code 3)')
    expect(mediaErrorReason({ code: 3 })).toBe('MEDIA_ERR_DECODE (code 3)')
  })

  it('reports an unknown code rather than answering with nothing', () => {
    const reason = mediaErrorReason({ code: 99, message: 'from the future' })
    expect(reason).toContain('99')
    expect(reason).toContain('from the future')
  })

  it('reports the absence of a MediaError as itself', () => {
    // `video.error` is null-typed, and an `error` event with nothing attached
    // is a real thing an element does. Silence here would be a failure with no
    // reason at all — the case the reason field exists to abolish, arriving
    // through the one path nobody thinks to test.
    const reason = mediaErrorReason(null)
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).toContain('MediaError')
  })
})

describe('VideoSource failure reasons', () => {
  it.each(MEDIA_ERRORS)('retains %o from the element rather than discarding it', (error, name, message) => {
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    expect(source.failed).toBe(false)
    expect(source.failureReason).toBe(null)

    element.error = error
    element.emit('error')

    expect(source.failed).toBe(true)
    expect(source.failureReason).toContain(name)
    expect(source.failureReason).toContain(`code ${error.code}`)
    expect(source.failureReason).toContain(message)
  })

  it('distinguishes a refused play() from a decode error', async () => {
    // The second of the three origins. A source that would not start and a
    // source that died mid-decode are the same `failed` bit, and the operator's
    // next move differs.
    const element = new FakeVideoElement()
    element.playRejectsWith = new DOMException('play() failed because the user agent refused', 'NotAllowedError')
    const source = sourceOver(element)
    source.play()
    await Promise.resolve()
    await Promise.resolve()

    expect(source.failed).toBe(true)
    expect(source.failureReason).toContain('NotAllowedError')
    expect(source.failureReason).not.toContain('MEDIA_ERR')
  })

  it('does not fail on the AbortError an ordinary cue change produces', async () => {
    // The positive control for the check above: if `play()`'s rejection path
    // failed every source, the previous test would pass for the wrong reason
    // and every cue change would raise a banner.
    const element = new FakeVideoElement()
    element.playRejectsWith = new DOMException('superseded by a new load', 'AbortError')
    const source = sourceOver(element)
    source.play()
    await Promise.resolve()
    await Promise.resolve()

    expect(source.failed).toBe(false)
    expect(source.failureReason).toBe(null)
  })

  it('names the third origin — a frame that could not be drawn — as itself', () => {
    // `compose.ts` calls this with a `SecurityError` off `getImageData` when
    // the canvas is tainted, which is a `corsEnabled`/`crossOrigin` problem and
    // not a problem with the clip. Telling those apart is the difference
    // between suspecting the media and suspecting `electron/main.ts`.
    const source = sourceOver(new FakeVideoElement())
    source.fail('SecurityError: Tainted canvases may not be exported.')

    expect(source.failed).toBe(true)
    expect(source.failureReason).toContain('SecurityError')
    expect(source.failureReason).not.toContain('MEDIA_ERR')
  })

  it('gives a cue with no media path a reason too', () => {
    const source = new VideoSource('   ', 0, { trimStartMs: 0, trimEndMs: null }, new FakeVideoElement() as unknown as HTMLVideoElement)
    expect(source.failed).toBe(true)
    expect(source.failureReason).not.toBe(null)
    expect(source.failureReason?.length ?? 0).toBeGreaterThan(0)
  })

  it('keeps the first reason when a dead decoder fails again downstream', () => {
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    element.error = { code: 3, message: 'DECODER_ERROR_NOT_SUPPORTED' }
    element.emit('error')
    source.fail('the decoded frame could not be drawn: InvalidStateError')

    expect(source.failureReason).toContain('DECODER_ERROR_NOT_SUPPORTED')
  })

  it('reports nothing once disposed, including the error disposal itself fires', () => {
    // Emptying `src` makes a real element fire `error`. A reason taken there
    // would put a banner in front of the operator about a cue nobody is playing.
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    source.dispose()

    element.error = { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }
    element.emit('error')
    expect(source.failed).toBe(false)
    expect(source.failureReason).toBe(null)
    // And the handlers are gone, which is what makes that true of a real
    // element rather than only of this fake.
    expect(element.listenerCount()).toBe(0)
  })
})

/**
 * Buffering: the mid-run case that had no channel at all.
 *
 * A clip that plays, halts for four seconds and resumes was, in every field the
 * engine published, a clip playing perfectly. The floor holds a frame — that is
 * `Sidecar` re-sending its last one — and nothing anywhere says why.
 *
 * Driven from the element's own `stalled` and `waiting` events, deliberately
 * not from a timer watching `currentTime`. Every threshold such a timer could
 * pick is wrong somewhere, and `CLAUDE.md` names what a warning that fires when
 * nothing is wrong does to the operator's attention.
 */
describe('VideoSource stalls', () => {
  it.each(['stalled', 'waiting'])('reports %s as transient, not as failure', (event) => {
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    expect(source.stallReason).toBe(null)

    element.emit(event)
    expect(source.stallReason).not.toBe(null)
    expect(source.stallReason).toContain(event)
    // The distinction the field exists for. A stall routed through `failed`
    // would take a cue off the wire for a clip that was about to recover.
    expect(source.failed).toBe(false)
    expect(source.failureReason).toBe(null)
  })

  it.each(['playing', 'canplay'])('clears a waiting on %s', (event) => {
    // Both, because they cover different sources: `playing` is the resume after
    // a `waiting` on a playing element, and `canplay` is the resume for one
    // that halted while paused or in pre-roll, for which `playing` never fires.
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    element.emit('waiting')
    expect(source.stallReason).not.toBe(null)

    element.emit(event)
    expect(source.stallReason).toBe(null)
  })

  it('clears a stalled on progress, with no playback event at all', () => {
    // The stuck-on case, and the reason `stalled` is not routed to the same
    // condition as `waiting`.
    //
    // `stalled` is the *fetch* going quiet. An element playing from data it
    // already has goes on playing throughout, so its `readyState` never falls
    // and it never fires `playing` or `canplay` when the download resumes —
    // `progress` is the only event that says the condition is over. Cleared
    // only on the playback events, this warning outlives its own condition and
    // sits over the operator for the rest of the show.
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    element.emit('stalled')
    expect(source.stallReason).not.toBe(null)

    element.emit('progress')
    expect(source.stallReason).toBe(null)
  })

  it('holds a waiting through progress, because bytes are not playback', () => {
    // The other half, and the one that keeps the fix from over-clearing. A
    // download filling a buffer the floor is still frozen behind fires
    // `progress` throughout; taking the warning down there reports a recovery
    // the operator can see has not happened.
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    element.emit('waiting')

    element.emit('progress')
    expect(source.stallReason).toContain('waiting')

    element.emit('playing')
    expect(source.stallReason).toBe(null)
  })

  it('drops a stall when the source fails, rather than reporting both', () => {
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    element.emit('waiting')
    element.error = { code: 2, message: 'NETWORK_ERROR' }
    element.emit('error')

    expect(source.stallReason).toBe(null)
    expect(source.failureReason).toContain('MEDIA_ERR_NETWORK')
  })
})

/**
 * The whole road, end to end: an element's `MediaError` reaching the one line
 * the operator reads.
 *
 * Graded on `snapshot().lastError` and not on `source.failureReason`, because
 * the field is not the deliverable — the banner is. Every link in between is a
 * place the reason was dropped before this change, and two of them (`fail`'s
 * signature, `reapFailures` reading the source before releasing it) are places
 * it could be dropped again by an edit that looks harmless.
 */
describe('a MediaError reaches the operator', () => {
  function showWith(path: string): Show {
    const cue: Cue = {
      id: 'a',
      name: 'Opener',
      source: { kind: 'video', path },
      loop: null,
      trimStartMs: 0,
      trimEndMs: null,
      mediaDurationMs: null,
      rotation: 0,
    }
    return { version: SHOW_FILE_VERSION, name: 'test show', floor: { type: '8x8_4P', tileCols: 10, tileRows: 5 }, cues: [cue] }
  }

  function rig(): { engine: PlayerEngine<VideoSource>; element: FakeVideoElement } {
    const element = new FakeVideoElement()
    const engine = new PlayerEngine<VideoSource>({
      show: showWith('/media/clip.mp4'),
      now: () => 0,
      createSource: (cue) =>
        new VideoSource(cue.source.path, cue.rotation, { trimStartMs: 0, trimEndMs: null }, element as unknown as HTMLVideoElement),
    })
    return { engine, element }
  }

  it.each(MEDIA_ERRORS)('puts %o in the banner, after the cue name', (error, name, message) => {
    const { engine, element } = rig()
    engine.goTo('a')
    element.error = error
    element.emit('error')
    engine.tick()

    const banner = engine.snapshot().lastError
    // Positive control for this assertion, not decoration. `not.toBe(null)` is
    // satisfied by `undefined`, so it passes against an engine that publishes
    // no such field at all — which is the implementation this test was written
    // to reject. Asserting the type and a non-zero length is what makes the
    // check capable of failing for the reason it claims to.
    expect(typeof banner).toBe('string')
    expect((banner ?? '').length).toBeGreaterThan(0)

    expect(banner).toContain('Opener')
    expect(banner).toContain(name)
    expect(banner).toContain(`code ${error.code}`)
    expect(banner).toContain(message)
  })

  it('reports a preview failure with its reason too', () => {
    const { engine, element } = rig()
    engine.setMode('preview')
    engine.selectCue('a')
    element.error = { code: 3, message: 'DECODER_ERROR_NOT_SUPPORTED' }
    element.emit('error')
    engine.tick()

    const banner = engine.snapshot().lastError
    expect(typeof banner).toBe('string')
    expect(banner).toContain('Opener')
    expect(banner).toContain('MEDIA_ERR_DECODE')
    expect(banner).toContain('DECODER_ERROR_NOT_SUPPORTED')
  })

  it('publishes a stall as a warning, separately from the error line', () => {
    const { engine, element } = rig()
    engine.goTo('a')
    element.readyState = 2
    element.emit('loadeddata')
    engine.tick()

    element.emit('waiting')
    const stalled = engine.snapshot()
    expect(typeof stalled.stallWarning).toBe('string')
    expect(stalled.stallWarning).toContain('Opener')
    // Two channels, not one. A stall arriving as `lastError` would say the cue
    // is over when it is buffering.
    expect(stalled.lastError).toBe(null)

    element.emit('playing')
    expect(engine.snapshot().stallWarning).toBe(null)
  })
})

/**
 * The restart, which nothing in this app did before.
 *
 * ## What was wrong
 *
 * `video.loop` was false, and the only wrap in the player was inside
 * `if (this.trimEndMs !== null)`. No surface in the app can set `trimEndMs` —
 * it is reachable only through `DDF_CUE_SEED`, a test seam — so the branch was
 * dead in every real show and every clip played once and froze on its last
 * frame. `PlayScreen` rendered a `LOOP ∞` chip over it and cue rows rendered
 * `∞`, so the app stated a behaviour it did not have: at a wedding that is a
 * still photograph on the floor for the rest of the set, with the UI saying it
 * is looping.
 *
 * ## Why it is graded on both paths
 *
 * `draw`'s wrap and the `ended` listener cover different failures and neither
 * subsumes the other. `draw` compares `currentTime` against the out-point once
 * per rendered frame, which is the only thing that can see a *bounded*
 * `trimEndMs` in the middle of the media — playback never reaches end of
 * stream there, so `ended` never fires. `ended` is the only thing that can see
 * the untrimmed case reliably, because the element may pause itself at EOF
 * with `currentTime` settled a frame short of `duration`, leaving `draw`'s
 * comparison false for ever.
 *
 * The wire gate (`test/e2e/wire.mjs` section 3c) grades the operator-visible
 * consequence — that the bytes on the wire keep changing after one clip length
 * has elapsed. These grade the two mechanisms that produce it.
 */
describe('a clip restarts rather than freezing', () => {
  /** The part of a 2D context `draw` touches. Records nothing; `draw`'s effect here is the seek. */
  function fakeContext(): CanvasRenderingContext2D {
    const noop = (): void => {}
    return {
      save: noop,
      restore: noop,
      setTransform: noop,
      fillRect: noop,
      translate: noop,
      rotate: noop,
      drawImage: noop,
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
    } as unknown as CanvasRenderingContext2D
  }

  /** A ready element sitting at `atSeconds` in a `durationSeconds` media. */
  function readyAt(atSeconds: number, durationSeconds: number): FakeVideoElement {
    const element = new FakeVideoElement()
    element.readyState = 2
    element.duration = durationSeconds
    element.currentTime = atSeconds
    return element
  }

  it('wraps an untrimmed clip to zero at the media duration', () => {
    const element = readyAt(0, 3)
    const source = sourceOver(element)
    element.emit('loadeddata')

    element.currentTime = 2.9
    source.draw(fakeContext(), 80, 40)
    expect(element.currentTime).toBe(2.9)

    element.currentTime = 3
    source.draw(fakeContext(), 80, 40)
    expect(element.currentTime).toBe(0)
  })

  it('wraps a trimmed clip to its in-point, not to zero', () => {
    const element = readyAt(0, 3)
    const source = new VideoSource(
      '/media/clip.mp4',
      0,
      { trimStartMs: 1_200, trimEndMs: null },
      element as unknown as HTMLVideoElement,
    )
    element.emit('loadeddata')

    element.currentTime = 3
    source.draw(fakeContext(), 80, 40)
    expect(element.currentTime).toBe(1.2)
  })

  it('does not wrap while the duration is still unknown', () => {
    // `duration` is NaN until the element has metadata, so `mediaDurationMs` is
    // null. A wrap here would seek a clip that is playing correctly.
    const element = new FakeVideoElement()
    element.readyState = 2
    element.currentTime = 5
    const source = sourceOver(element)
    element.emit('loadeddata')

    source.draw(fakeContext(), 80, 40)
    expect(element.currentTime).toBe(5)
  })

  it('seeks to the in-point and plays again when the element reports end of stream', () => {
    const element = readyAt(3, 3)
    const source = new VideoSource(
      '/media/clip.mp4',
      0,
      { trimStartMs: 1_200, trimEndMs: null },
      element as unknown as HTMLVideoElement,
    )
    element.emit('loadeddata')
    const playsBefore = element.playCalls

    element.emit('ended')

    expect(element.currentTime).toBe(1.2)
    expect(element.playCalls).toBe(playsBefore + 1)
    expect(source.failed).toBe(false)
  })

  /**
   * The seek is what these two grade, not the `play()`.
   *
   * `play()` refuses on a disposed or failed source already, so a call count is
   * blind to `onEnded`'s own guard: delete that guard and every play-count
   * assertion here still passes. The mutation check found exactly that. The
   * seek is the guard's one distinct effect, so the seek is what the assertion
   * has to be about — otherwise this is a pair of tests that cannot fail for
   * the thing they claim to be about.
   */
  it('does not restart a disposed source', () => {
    // Which is a statement about `dispose`, not about a guard inside
    // `onEnded`: the listener is gone by the time this event is emitted. That
    // is the reason `onEnded` checks `failed` alone — see its comment.
    const element = readyAt(3, 3)
    const source = sourceOver(element)
    element.emit('loadeddata')
    source.dispose()
    const playsBefore = element.playCalls

    element.emit('ended')
    expect(element.currentTime).toBe(3)
    expect(element.playCalls).toBe(playsBefore)
  })

  it('does not restart a failed source', () => {
    const element = readyAt(3, 3)
    const source = sourceOver(element)
    element.emit('loadeddata')
    source.fail('the decoded frame could not be drawn')
    const playsBefore = element.playCalls

    element.emit('ended')
    expect(element.currentTime).toBe(3)
    expect(element.playCalls).toBe(playsBefore)

    // And `draw` must not seek a dead source either — the floor is black and
    // the operator has a banner about this cue.
    source.draw(fakeContext(), 80, 40)
    expect(element.currentTime).toBe(3)
  })

  it('drops the ended listener on dispose along with the rest', () => {
    const element = new FakeVideoElement()
    const source = sourceOver(element)
    expect(element.listenerCount()).toBeGreaterThan(0)
    source.dispose()
    expect(element.listenerCount()).toBe(0)
  })
})
