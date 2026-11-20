/**
 * Decode recovery in `VideoSource`: the spec for branch `app-decode-recovery`.
 *
 * ## The defect
 *
 * The 2026-09-05/06 job logged 116 `PIPELINE_ERROR_DECODE` failures — 78 in
 * preview, 37 that stopped a live cue, 1 that failed to play. 32 of the 37 live
 * stops came 0.2–8 s after the cue was promoted. Every one of them blacked the
 * floor, because a decode error is terminal: `onError` calls `state.fail`, and
 * `PlayerEngine.reapFailures` answers a failed live source with `clearLive`.
 * The root cause is not established (one pre-fix trace shows VideoToolbox
 * `DecoderStatus::104` on an Intel i7-9750H — one observed path, not a proof).
 *
 * ## What this file specifies
 *
 * A `MEDIA_ERR_DECODE` on a source that has already been ready is treated as
 * possibly transient: the source tears down its element and starts a reload
 * attempt on a **fresh element** from the injected factory, holding its own
 * last-good frame on whatever surface draws it until the new attempt has a
 * frame. Attempts are bounded (3 s each, 8 s per episode, at most 3 in any 30 s)
 * and exhaustion is today's terminal failure with today's reason.
 *
 * The Codex QC of 2026-11-20 (gpt-6.2-sol, findings 1, 3 and 5) is why each of
 * the following is a requirement rather than a nicety:
 *
 *   - The App composes live and preview through **one shared work canvas**. A
 *     recovering source that skipped its draw would leave the previous
 *     compose's pixels — possibly *preview* pixels — in the canvas the wire
 *     reads back. So a recovering `draw` always paints the whole canvas: its
 *     own snapshot, or black.
 *   - `ready` latches. Promotion must read a per-attempt `drawable`, or a
 *     reloading pending source is promoted with no frame (engine.test.ts).
 *   - Events, promises and frame callbacks from a superseded attempt must not
 *     act on the current one.
 *
 * ## The seams
 *
 * Constructor parameter 5, `VideoSourceOptions`, all optional with DOM/real
 * defaults: `createElement` (each reload attempt's element), `createCanvas`
 * (the snapshot surface), `now`, `setTimer`, `clearTimer`. Everything here is
 * driven through fakes; no DOM, per `docs/APP-PLAN.md` ("no third harness").
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  RECOVERY_ATTEMPT_TIMEOUT_MS,
  RECOVERY_EPISODE_DEADLINE_MS,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_WINDOW_MS,
  VideoSource,
  coverRect,
  rotatedTargetSize,
  type SnapshotSurface,
} from '../src/player/videoSource'
import { decoderCensus } from '../src/player/decoderCensus'
import { PlayerEngine, type SlotRecoveryEvent } from '../src/player/engine'
import { SHOW_FILE_VERSION, type Cue, type Show } from '../src/player/show'
import type { Rotation } from '../src/render/geometry'

beforeAll(() => {
  const globals = globalThis as unknown as { HTMLMediaElement?: unknown }
  globals.HTMLMediaElement ??= { HAVE_CURRENT_DATA: 2 }
})

// --------------------------------------------------------------------- fakes

interface FakeMediaError {
  readonly code: number
  readonly message: string
}

/**
 * The element `VideoSource` drives, extended from the one in
 * `videoSource.test.ts` with three things recovery needs to be graded:
 * `playing` (the last of play/pause wins, which is the pause *intent* an
 * implementation is free to reach either way), a gate that holds `play()`'s
 * promise open so a stale rejection can land late, and optional frame
 * callbacks.
 */
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
  playing = false
  playRejectsWith: unknown = null
  playGate: Promise<void> | null = null

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
    this.playing = false
  }

  removeAttribute(): void {
    this.src = ''
  }

  async play(): Promise<void> {
    this.playCalls += 1
    this.playing = true
    if (!this.loop && Number.isFinite(this.duration) && this.currentTime >= this.duration) {
      this.currentTime = 0
    }
    if (this.playGate !== null) await this.playGate
    if (this.playRejectsWith !== null) throw this.playRejectsWith
  }

  emit(type: string): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type } as Event)
  }

  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

class FakeFramingVideoElement extends FakeVideoElement {
  private nextId = 1
  private readonly callbacks = new Map<number, VideoFrameRequestCallback>()

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const id = this.nextId
    this.nextId += 1
    this.callbacks.set(id, callback)
    return id
  }

  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id)
  }

  pending(): number {
    return this.callbacks.size
  }

  present(presentedFrames: number): void {
    const due = [...this.callbacks.values()]
    this.callbacks.clear()
    const metadata = { presentedFrames, mediaTime: presentedFrames / 30 } as VideoFrameCallbackMetadata
    for (const callback of due) callback(0, metadata)
  }
}

interface Op {
  readonly op: string
  readonly args: readonly unknown[]
  readonly fillStyle?: unknown
}

/** A 2D context that records what was done to it, in order. */
class RecordingContext {
  ops: Op[] = []
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  fillStyle: unknown = '#000000'
  drawImageThrows: unknown = null

  save(): void { this.ops.push({ op: 'save', args: [] }) }
  restore(): void { this.ops.push({ op: 'restore', args: [] }) }
  setTransform(...args: unknown[]): void { this.ops.push({ op: 'setTransform', args }) }
  translate(...args: unknown[]): void { this.ops.push({ op: 'translate', args }) }
  rotate(...args: unknown[]): void { this.ops.push({ op: 'rotate', args }) }
  fillRect(...args: unknown[]): void { this.ops.push({ op: 'fillRect', args, fillStyle: this.fillStyle }) }
  clearRect(...args: unknown[]): void { this.ops.push({ op: 'clearRect', args }) }
  drawImage(...args: unknown[]): void {
    if (this.drawImageThrows !== null) throw this.drawImageThrows
    this.ops.push({ op: 'drawImage', args })
  }

  draws(): Op[] {
    return this.ops.filter((o) => o.op === 'drawImage')
  }

  asContext(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D
  }
}

class FakeCanvas {
  width = 0
  height = 0
}

/** A clock and a timer queue the test advances by hand. */
class FakeClock {
  t = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  readonly now = (): number => this.t
  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  /** Move time forward, firing due timers in order at their own instants. */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const entry of this.timers) {
        if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry
      }
      if (next === null) break
      this.timers.delete(next[0])
      this.t = next[1].at
      next[1].fn()
    }
    this.t = end
  }

  pending(): number {
    return this.timers.size
  }
}

// ---------------------------------------------------------------------- rigs

interface Rig {
  readonly source: VideoSource
  readonly elements: FakeVideoElement[]
  readonly surfaces: Array<{ canvas: FakeCanvas; context: RecordingContext }>
  readonly clock: FakeClock
  /** The element the source is currently driving. */
  current(): FakeVideoElement
}

const DECODE_MESSAGE = 'PIPELINE_ERROR_DECODE: VideoToolbox decode failed (DecoderStatus::104)'

function rig(options: {
  trimStartMs?: number
  trimEndMs?: number | null
  rotation?: Rotation
  framing?: boolean
  noCanvas?: boolean
} = {}): Rig {
  const make = (): FakeVideoElement => (options.framing === true ? new FakeFramingVideoElement() : new FakeVideoElement())
  const elements: FakeVideoElement[] = [make()]
  const surfaces: Array<{ canvas: FakeCanvas; context: RecordingContext }> = []
  const clock = new FakeClock()
  const source = new VideoSource(
    '/media/clip.mp4',
    options.rotation ?? 0,
    { trimStartMs: options.trimStartMs ?? 0, trimEndMs: options.trimEndMs ?? null },
    elements[0] as unknown as HTMLVideoElement,
    {
      createElement: () => {
        const element = make()
        elements.push(element)
        return element as unknown as HTMLVideoElement
      },
      createCanvas: () => {
        if (options.noCanvas === true) return null
        const surface = { canvas: new FakeCanvas(), context: new RecordingContext() }
        surfaces.push(surface)
        return surface as unknown as SnapshotSurface
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  )
  return { source, elements, surfaces, clock, current: () => elements[elements.length - 1] as FakeVideoElement }
}

/**
 * Give an element a decoded 1920 x 1080 frame and say so, with every event a
 * real element fires on the way there — so an implementation is free to seek
 * on `loadedmetadata` or to wait for `seeked`, and is graded on the outcome.
 */
function decodeFrame(element: FakeVideoElement, at = element.currentTime): void {
  element.duration = 10
  element.videoWidth = 1_920
  element.videoHeight = 1_080
  element.currentTime = at
  element.readyState = 1
  element.emit('loadedmetadata')
  element.readyState = 2
  element.emit('loadeddata')
  element.emit('seeked')
  element.emit('canplay')
}

function decodeError(element: FakeVideoElement, message = DECODE_MESSAGE): void {
  element.error = { code: 3, message }
  element.emit('error')
}

function draw(source: VideoSource, width = 512, height = 512): RecordingContext {
  const context = new RecordingContext()
  source.draw(context.asContext(), width, height)
  return context
}

/** A ready, playing source that has put one good frame through `draw`. */
function playingRig(options: Parameters<typeof rig>[0] = {}): Rig {
  const r = rig(options)
  r.source.play()
  decodeFrame(r.elements[0] as FakeVideoElement, (options.trimStartMs ?? 0) / 1_000 + 1)
  draw(r.source)
  return r
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** `fillRect` over the whole canvas, in black. */
function paintsBlackFirst(context: RecordingContext, width: number, height: number): boolean {
  const fill = context.ops.find((o) => o.op === 'fillRect')
  return fill !== undefined
    && fill.args[0] === 0 && fill.args[1] === 0 && fill.args[2] === width && fill.args[3] === height
    && String(fill.fillStyle).toLowerCase() === '#000000'
}

/**
 * Precondition for every test that grades behaviour *during* a reload: a new
 * element exists and the source has not failed. Without it those tests pass
 * on stock main, where the decode error fails the source and `current()` is
 * still the first element — found by running this spec against main.
 */
function expectReloading(r: Rig, elements = 2): void {
  expect(r.elements).toHaveLength(elements)
  expect(r.source.failed).toBe(false)
}

// ------------------------------------------------------------------- 1. identity

describe('recovery 1: each attempt has its own identity', () => {
  it('starts reload attempt 1 on a fresh element instead of failing', () => {
    const r = playingRig()
    const first = r.elements[0] as FakeVideoElement
    const mediaSrc = first.src
    expect(mediaSrc.length).toBeGreaterThan(0)
    decodeError(first)

    expect(r.source.failed).toBe(false)
    expect(r.source.failureReason).toBe(null)
    expect(r.elements).toHaveLength(2)
    // The old element is released: no listeners left, no media attached.
    expect(first.listenerCount()).toBe(0)
    expect(first.src).toBe('')
    // The new one is loading the same media, CORS-mode like the first.
    const second = r.current()
    expect(second.src).toBe(mediaSrc)
    expect(second.crossOrigin).toBe('anonymous')
    expect(second.loop).toBe(false)
    expect(second.loadCalls).toBeGreaterThan(0)
  })

  it('ignores events from the superseded element', () => {
    const r = playingRig()
    const first = r.elements[0] as FakeVideoElement
    decodeError(first)

    // A frame announced by the old element is not a frame of this attempt.
    first.readyState = 2
    first.emit('loadeddata')
    first.emit('canplay')
    expect(r.source.drawable).toBe(false)

    // A second error from the old element starts nothing and fails nothing.
    decodeError(first)
    expect(r.elements).toHaveLength(2)
    expect(r.source.failed).toBe(false)
  })

  it('ignores a play() rejection that belongs to the superseded attempt', async () => {
    const r = rig()
    const first = r.elements[0] as FakeVideoElement
    let release: () => void = () => {}
    first.playGate = new Promise<void>((resolve) => { release = resolve })
    first.playRejectsWith = new DOMException('refused', 'NotAllowedError')
    r.source.play()
    decodeFrame(first, 1)
    draw(r.source)

    decodeError(first)
    release()
    await flushMicrotasks()

    // Without attempt identity this rejection fails a source that is mid-recovery.
    expect(r.source.failed).toBe(false)
  })

  it('positive control: a play() rejection on the current element still fails the source', async () => {
    const r = rig()
    const first = r.elements[0] as FakeVideoElement
    first.playRejectsWith = new DOMException('refused', 'NotAllowedError')
    r.source.play()
    await flushMicrotasks()
    expect(r.source.failed).toBe(true)
  })

  it('cancels the old frame callback and arms one on the new element', () => {
    const r = playingRig({ framing: true })
    const first = r.elements[0] as FakeFramingVideoElement
    expect(first.pending()).toBe(1)
    decodeError(first)

    expect(first.pending()).toBe(0)
    expect((r.current() as FakeFramingVideoElement).pending()).toBe(1)
  })

  it('treats a decode error on the attempt\'s own element as the next attempt', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    const second = r.current()
    decodeError(second)

    expect(r.elements).toHaveLength(3)
    expect(second.listenerCount()).toBe(0)
    expect(r.source.failed).toBe(false)
  })

  it('stays terminal for a decode error before the source was ever ready', () => {
    // A clip that never produced a frame is not a transient failure of a clip
    // that was playing; it keeps today's behaviour exactly.
    const r = rig()
    decodeError(r.elements[0] as FakeVideoElement)
    expect(r.source.failed).toBe(true)
    expect(r.source.failureReason).toContain('MEDIA_ERR_DECODE')
    expect(r.elements).toHaveLength(1)
  })

  it.each([
    [1, 'load aborted'],
    [2, 'NETWORK_ERROR'],
    [4, 'DEMUXER_ERROR_COULD_NOT_OPEN'],
  ])('stays terminal for MediaError code %i on a ready source', (code, message) => {
    const r = playingRig()
    const first = r.elements[0] as FakeVideoElement
    first.error = { code, message }
    first.emit('error')
    expect(r.source.failed).toBe(true)
    expect(r.source.failureReason).toContain(message)
    expect(r.elements).toHaveLength(1)
  })
})

// ---------------------------------------------------------- 2. last-good frame

describe('recovery 2: the source holds its own last-good frame', () => {
  it('writes the snapshot only from a successful draw of the element', () => {
    const r = rig()
    r.source.play()
    decodeFrame(r.elements[0] as FakeVideoElement, 1)
    // Ready, but nothing drawn yet: no snapshot of anything.
    const before = r.surfaces.reduce((n, s) => n + s.context.draws().length, 0)
    expect(before).toBe(0)

    draw(r.source)
    const snapshotDraws = r.surfaces.flatMap((s) => s.context.draws())
    expect(snapshotDraws.length).toBeGreaterThan(0)
    expect(snapshotDraws[snapshotDraws.length - 1]?.args[0]).toBe(r.elements[0])
  })

  it('does not write the snapshot when the element draw throws', () => {
    const r = playingRig()
    const count = (): number => r.surfaces.reduce((n, s) => n + s.context.draws().length, 0)
    const before = count()
    expect(before).toBeGreaterThan(0)
    const context = new RecordingContext()
    context.drawImageThrows = new DOMException('bad frame', 'InvalidStateError')
    r.source.draw(context.asContext(), 512, 512)
    expect(count()).toBe(before)
  })

  it('paints black then the snapshot while reloading, and never an element', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    const snapshot = r.surfaces[r.surfaces.length - 1]?.canvas
    expect(snapshot).toBeDefined()

    const context = draw(r.source, 512, 512)
    // The whole shared canvas is overwritten: nothing from a previous compose survives.
    expect(paintsBlackFirst(context, 512, 512)).toBe(true)
    const images = context.draws().map((o) => o.args[0])
    expect(images).toEqual([snapshot])
    for (const element of r.elements) expect(images).not.toContain(element)
  })

  it('paints black and nothing else when there is no snapshot to hold', () => {
    // Ready from `loadeddata` but never drawn — the pending-source case.
    const r = rig()
    r.source.play()
    decodeFrame(r.elements[0] as FakeVideoElement, 1)
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)

    const context = draw(r.source, 512, 512)
    expect(paintsBlackFirst(context, 512, 512)).toBe(true)
    expect(context.draws()).toHaveLength(0)
  })

  it('paints black when no snapshot surface can be created', () => {
    const r = playingRig({ noCanvas: true })
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    const context = draw(r.source, 512, 512)
    expect(paintsBlackFirst(context, 512, 512)).toBe(true)
    expect(context.draws()).toHaveLength(0)
  })

  it('draws the held frame through the current rotation', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    r.source.setRotation(90)

    const context = draw(r.source, 512, 256)
    const rotate = context.ops.filter((o) => o.op === 'rotate').map((o) => o.args[0] as number)
    expect(rotate.some((angle) => Math.abs(angle - Math.PI / 2) < 1e-9)).toBe(true)
    // Cover-fit against the rotated target, at the video's own aspect.
    const target = rotatedTargetSize(512, 256, 90)
    const [, , , w, h] = context.draws()[0]?.args as number[]
    expect(w).toBeGreaterThanOrEqual(target.width - 1e-6)
    expect(h).toBeGreaterThanOrEqual(target.height - 1e-6)
    expect(w / h).toBeCloseTo(1_920 / 1_080, 2)
  })

  it('covers a resized canvas with the held frame', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)

    const context = draw(r.source, 256, 128)
    expect(paintsBlackFirst(context, 256, 128)).toBe(true)
    const [, x, y, w, h] = context.draws()[0]?.args as number[]
    const expected = coverRect(1_920, 1_080, 256, 128)
    expect(w).toBeGreaterThanOrEqual(256 - 1e-6)
    expect(h).toBeGreaterThanOrEqual(128 - 1e-6)
    expect(w / h).toBeCloseTo(expected.width / expected.height, 2)
    // Centred, as a live frame would be: offsets relative to the translated centre.
    expect(x).toBeCloseTo(-w / 2, 3)
    expect(y).toBeCloseTo(-h / 2, 3)
  })

  it('draws the new element again once recovered, and refreshes the snapshot from it', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    const second = r.current()
    decodeFrame(second, 1)

    const context = draw(r.source)
    expect(context.draws().map((o) => o.args[0])).toEqual([second])
    const snapshotDraws = r.surfaces.flatMap((s) => s.context.draws())
    expect(snapshotDraws[snapshotDraws.length - 1]?.args[0]).toBe(second)
  })
})

// ------------------------------------------------------ 3. per-attempt readiness

describe('recovery 3: drawable is per attempt; ready stays latched', () => {
  it('is drawable when ready, and not before', () => {
    const r = rig()
    expect(r.source.drawable).toBe(false)
    decodeFrame(r.elements[0] as FakeVideoElement, 0)
    expect(r.source.ready).toBe(true)
    expect(r.source.drawable).toBe(true)
  })

  it('is not drawable while reloading, though still ready', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    expect(r.source.ready).toBe(true)
    expect(r.source.drawable).toBe(false)
  })

  it('does not count a new element with no decoded data as a frame', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    const second = r.current()
    second.readyState = 1
    second.emit('loadeddata')
    second.emit('canplay')
    expect(r.source.drawable).toBe(false)
  })

  it('becomes drawable on the new element\'s first decoded frame', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    decodeFrame(r.current(), 1)
    expect(r.source.drawable).toBe(true)
  })

  it('becomes drawable from a frame callback on the new element', () => {
    const r = playingRig({ framing: true })
    decodeError(r.elements[0] as FakeVideoElement)
    const second = r.current() as FakeFramingVideoElement
    second.readyState = 2
    second.videoWidth = 1_920
    second.videoHeight = 1_080
    second.present(1)
    expect(r.source.drawable).toBe(true)
  })

  it('is not drawable once failed or disposed', () => {
    const failed = playingRig()
    failed.source.fail('the decoded frame could not be drawn')
    expect(failed.source.drawable).toBe(false)

    const disposed = playingRig()
    disposed.source.dispose()
    expect(disposed.source.drawable).toBe(false)
  })

  it('reports the hold as a stall while reloading, and clears it on recovery', () => {
    // The operator-visible channel. A floor holding a frozen frame with no
    // warning anywhere is the silence CLAUDE.md says must not read as success.
    const r = playingRig()
    expect(r.source.stallReason).toBe(null)
    decodeError(r.elements[0] as FakeVideoElement)
    expect(r.source.stallReason).toMatch(/recover/i)
    decodeFrame(r.current(), 1)
    expect(r.source.stallReason).toBe(null)
  })
})

// ------------------------------------------------------------------ 4. deadlines

describe('recovery 4: attempts are bounded', () => {
  it('uses the planned budget', () => {
    expect(RECOVERY_ATTEMPT_TIMEOUT_MS).toBe(3_000)
    expect(RECOVERY_EPISODE_DEADLINE_MS).toBe(8_000)
    expect(RECOVERY_MAX_ATTEMPTS).toBe(3)
    expect(RECOVERY_WINDOW_MS).toBe(30_000)
  })

  it('starts the next attempt when one produces no frame in 3 s', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    r.clock.advance(2_999)
    expect(r.elements).toHaveLength(2)
    r.clock.advance(1)
    expect(r.elements).toHaveLength(3)
    expect(r.source.failed).toBe(false)
  })

  it('fails at the 8 s episode deadline with the original reason, after 3 attempts', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    r.clock.advance(7_999)
    expect(r.source.failed).toBe(false)
    expect(r.elements).toHaveLength(4)
    r.clock.advance(1)
    expect(r.source.failed).toBe(true)
    expect(r.source.failureReason).toContain('MEDIA_ERR_DECODE')
    expect(r.source.failureReason).toContain(DECODE_MESSAGE)
    // Exhaustion leaves nothing scheduled to act on a dead source.
    expect(r.clock.pending()).toBe(0)
    expect(r.elements).toHaveLength(4)
  })

  it('fails at once on a decode error with no attempts left', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    decodeError(r.current())
    decodeError(r.current())
    expect(r.elements).toHaveLength(4)
    expect(r.source.failed).toBe(false)

    decodeError(r.current(), 'PIPELINE_ERROR_DECODE: second failure')
    expect(r.source.failed).toBe(true)
    // The first error is the diagnosis; later ones are its consequences.
    expect(r.source.failureReason).toContain(DECODE_MESSAGE)
    expect(r.elements).toHaveLength(4)
    expect(r.clock.pending()).toBe(0)
  })

  it('allows at most 3 attempts in any 30 s, across recovered episodes', () => {
    const r = playingRig()
    for (let episode = 0; episode < 3; episode += 1) {
      decodeError(r.current())
      r.clock.advance(100)
      decodeFrame(r.current(), 1)
      expect(r.source.drawable).toBe(true)
      r.clock.advance(1_000)
    }
    expect(r.elements).toHaveLength(4)

    decodeError(r.current())
    expect(r.source.failed).toBe(true)
    expect(r.elements).toHaveLength(4)
  })

  it('lets the 30 s window roll', () => {
    const r = playingRig()
    for (let episode = 0; episode < 3; episode += 1) {
      decodeError(r.current())
      decodeFrame(r.current(), 1)
    }
    r.clock.advance(RECOVERY_WINDOW_MS + 1)
    decodeError(r.current())
    expect(r.source.failed).toBe(false)
    expect(r.elements).toHaveLength(5)
  })

  it('stops counting down once recovered', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    decodeFrame(r.current(), 1)
    r.clock.advance(20_000)
    expect(r.source.failed).toBe(false)
    expect(r.elements).toHaveLength(2)
    expect(r.clock.pending()).toBe(0)
  })
})

// --------------------------------------------------------------- 5. pause, wrap

describe('recovery 5: pause intent and trim survive a reload', () => {
  it('does not restart or seek on an ended during reload', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    const second = r.current()
    const position = second.currentTime
    const plays = second.playCalls
    second.duration = 10
    second.emit('ended')
    expect(second.currentTime).toBe(position)
    expect(second.playCalls).toBe(plays)
  })

  it('does not seek the new element from draw during reload', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    const second = r.current()
    second.duration = 10
    second.currentTime = 10
    draw(r.source)
    expect(second.currentTime).toBe(10)
  })

  it('resumes from the last good position, inside the trim', () => {
    const r = playingRig({ trimStartMs: 1_200 })
    const first = r.elements[0] as FakeVideoElement
    first.currentTime = 4.5
    draw(r.source)
    decodeError(first)
    expectReloading(r)
    const second = r.current()
    decodeFrame(second, second.currentTime)
    expect(second.currentTime).toBeCloseTo(4.5, 3)
    expect(second.playing).toBe(true)
  })

  /**
   * The resume position is the failed element's `currentTime` when the error
   * arrived, put through the existing trim rule (`trimWrapPoint` against
   * `trimEndMs ?? the old element's duration`). No `draw` here on purpose:
   * a draw at the out-point would wrap the old element first and prove nothing.
   */
  it('resumes at the in-point when the error came at the out-point', () => {
    const r = playingRig({ trimStartMs: 1_200 })
    const first = r.elements[0] as FakeVideoElement
    first.currentTime = 10
    decodeError(first)
    expectReloading(r)
    const second = r.current()
    decodeFrame(second, second.currentTime)
    expect(second.currentTime).toBeCloseTo(1.2, 3)
  })

  it('stays paused when PAUSE was pressed during the reload', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    r.source.pause()
    const second = r.current()
    decodeFrame(second, second.currentTime)
    expect(second.playing).toBe(false)
  })

  it('plays when RESUME was pressed during the reload', () => {
    const r = playingRig()
    r.source.pause()
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    r.source.play()
    const second = r.current()
    decodeFrame(second, second.currentTime)
    expect(second.playing).toBe(true)
  })

  it('does not start a source that was paused when the error came', () => {
    const r = playingRig()
    r.source.pause()
    decodeError(r.elements[0] as FakeVideoElement)
    expectReloading(r)
    const second = r.current()
    decodeFrame(second, second.currentTime)
    expect(second.playing).toBe(false)
  })
})

// ---------------------------------------------------------------- 6. supersession

describe('recovery 6: disposal during recovery is clean', () => {
  it('leaves no timer, listener, frame callback or census entry behind', () => {
    const baseline = decoderCensus().live
    const r = playingRig({ framing: true })
    expect(decoderCensus().live).toBe(baseline + 1)
    decodeError(r.elements[0] as FakeVideoElement)
    // A reload is the same source: one census entry, not two.
    expect(decoderCensus().live).toBe(baseline + 1)

    r.source.dispose()
    expect(decoderCensus().live).toBe(baseline)
    expect(r.clock.pending()).toBe(0)
    for (const element of r.elements) {
      expect(element.listenerCount()).toBe(0)
      expect((element as FakeFramingVideoElement).pending()).toBe(0)
      expect(element.src).toBe('')
    }

    // And nothing wakes up later.
    r.clock.advance(60_000)
    expect(r.elements).toHaveLength(2)
    expect(r.source.failed).toBe(false)
  })

  it('reports no events after disposal', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    r.source.takeRecoveryEvents()
    r.source.dispose()
    r.clock.advance(60_000)
    expect(r.source.takeRecoveryEvents()).toEqual([])
  })
})

// ---------------------------------------------------------------- 7. events

describe('recovery 7: attempts and recoveries are events', () => {
  it('reports an attempt per reload, each carrying the original error', () => {
    const r = playingRig()
    expect(r.source.takeRecoveryEvents()).toEqual([])
    decodeError(r.elements[0] as FakeVideoElement)
    r.clock.advance(3_000)

    const events = r.source.takeRecoveryEvents()
    expect(events.map((e) => [e.kind, e.attempt, e.elapsedMs])).toEqual([
      ['attempt', 1, 0],
      ['attempt', 2, 3_000],
    ])
    for (const event of events) {
      expect(event.originalError).toContain('MEDIA_ERR_DECODE')
      expect(event.originalError).toContain(DECODE_MESSAGE)
    }
    // Drained.
    expect(r.source.takeRecoveryEvents()).toEqual([])
  })

  it('reports recovered only after the new attempt has a frame', () => {
    const r = playingRig()
    decodeError(r.elements[0] as FakeVideoElement)
    r.source.takeRecoveryEvents()
    r.clock.advance(1_250)
    expect(r.source.takeRecoveryEvents()).toEqual([])

    decodeFrame(r.current(), 1)
    const events = r.source.takeRecoveryEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'recovered', attempt: 1, elapsedMs: 1_250 })
    expect(events[0]?.originalError).toContain(DECODE_MESSAGE)
  })

  it('reports nothing for a source that never needed recovery', () => {
    const r = playingRig()
    r.clock.advance(60_000)
    draw(r.source)
    expect(r.source.takeRecoveryEvents()).toEqual([])
  })
})

// ------------------------------------------------------- end to end, real sources

describe('recovery through the engine, with real VideoSources', () => {
  function cue(id: string): Cue {
    return {
      id,
      name: `Cue ${id}`,
      source: { kind: 'video', path: `/media/${id}.mp4` },
      loop: null,
      trimStartMs: 0,
      trimEndMs: null,
      mediaDurationMs: null,
      rotation: 0,
    }
  }

  function show(...cues: Cue[]): Show {
    return { version: SHOW_FILE_VERSION, name: 'test', floor: { type: '8x8_4P', tileCols: 8, tileRows: 8 }, cues }
  }

  function engineRig(...cues: Cue[]) {
    const clock = new FakeClock()
    const elements = new Map<string, FakeVideoElement[]>()
    const sources = new Map<string, VideoSource>()
    const events: SlotRecoveryEvent[] = []
    const engine = new PlayerEngine<VideoSource>({
      show: show(...cues),
      now: clock.now,
      onRecoveryEvent: (event) => events.push(event),
      createSource: (c) => {
        const list: FakeVideoElement[] = [new FakeVideoElement()]
        elements.set(c.id, list)
        const source = new VideoSource(
          c.source.path,
          c.rotation,
          { trimStartMs: 0, trimEndMs: null },
          list[0] as unknown as HTMLVideoElement,
          {
            createElement: () => {
              const element = new FakeVideoElement()
              list.push(element)
              return element as unknown as HTMLVideoElement
            },
            createCanvas: () => ({ canvas: new FakeCanvas(), context: new RecordingContext() }) as unknown as SnapshotSurface,
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
          },
        )
        sources.set(c.id, source)
        return source
      },
    })
    const el = (id: string): FakeVideoElement => {
      const list = elements.get(id)
      if (list === undefined) throw new Error(`no source for ${id}`)
      return list[list.length - 1] as FakeVideoElement
    }
    const src = (id: string): VideoSource => {
      const found = sources.get(id)
      if (found === undefined) throw new Error(`no source for ${id}`)
      return found
    }
    return { engine, clock, el, src, events, elements }
  }

  it('holds a recovering live cue on the wire and resumes it, with no banner', () => {
    const r = engineRig(cue('a'))
    r.engine.goTo('a')
    decodeFrame(r.el('a'), 1)
    expect(r.engine.tick().wire).toEqual({ kind: 'source', source: r.src('a') })
    draw(r.src('a'))

    decodeError(r.el('a'))
    for (let i = 0; i < 10; i += 1) {
      r.clock.advance(100)
      expect(r.engine.tick().wire).toEqual({ kind: 'source', source: r.src('a') })
    }
    expect(r.engine.snapshot().lastError).toBe(null)
    expect(r.engine.snapshot().stallWarning).toMatch(/recover/i)

    decodeFrame(r.el('a'), 1)
    r.engine.tick()
    expect(r.engine.snapshot().stallWarning).toBe(null)
    expect(r.events.map((e) => [e.slot, e.kind])).toEqual([['live', 'attempt'], ['live', 'recovered']])
  })

  it('blacks the floor with today\'s banner when recovery is exhausted', () => {
    const r = engineRig(cue('a'))
    r.engine.goTo('a')
    decodeFrame(r.el('a'), 1)
    r.engine.tick()
    draw(r.src('a'))

    decodeError(r.el('a'))
    r.engine.tick()
    // It tried first: this is exhaustion, not today's immediate failure.
    expect(r.engine.snapshot().liveCueId).toBe('a')
    r.clock.advance(RECOVERY_EPISODE_DEADLINE_MS)
    expect(r.elements.get('a')).toHaveLength(4)
    expect(r.engine.tick().wire).toEqual({ kind: 'black' })
    expect(r.engine.snapshot().lastError).toContain('stopped playing')
    expect(r.engine.snapshot().lastError).toContain(DECODE_MESSAGE)
  })

  it('keeps the outgoing cue on the wire while a pending one reloads, then promotes it', () => {
    const r = engineRig(cue('a'), cue('b'))
    r.engine.goTo('a')
    decodeFrame(r.el('a'), 1)
    r.engine.tick()

    r.engine.goTo('b')
    // Ready, then a decode error before the engine ever saw it: latched
    // `ready` must not promote it.
    decodeFrame(r.el('b'), 0)
    decodeError(r.el('b'))
    for (let i = 0; i < 5; i += 1) {
      expect(r.engine.tick().wire).toEqual({ kind: 'source', source: r.src('a') })
    }
    expect(r.engine.snapshot().pendingCueId).toBe('b')

    decodeFrame(r.el('b'), 0)
    expect(r.engine.tick().wire).toEqual({ kind: 'source', source: r.src('b') })
    expect(r.events.map((e) => [e.slot, e.cueId, e.kind])).toEqual([
      ['pending', 'b', 'attempt'],
      ['pending', 'b', 'recovered'],
    ])
  })

  it('lets GO supersede a live recovery cleanly', () => {
    const r = engineRig(cue('a'), cue('b'))
    r.engine.goTo('a')
    decodeFrame(r.el('a'), 1)
    r.engine.tick()
    draw(r.src('a'))
    decodeError(r.el('a'))
    expect(r.elements.get('a')).toHaveLength(2)

    r.engine.goTo('b')
    decodeFrame(r.el('b'), 0)
    expect(r.engine.tick().wire).toEqual({ kind: 'source', source: r.src('b') })

    // The recovering source is gone, and nothing of it is left to fire.
    for (const element of r.elements.get('a') ?? []) expect(element.listenerCount()).toBe(0)
    const before = r.elements.get('a')?.length
    r.clock.advance(60_000)
    expect(r.elements.get('a')?.length).toBe(before)
    expect(r.clock.pending()).toBe(0)
    r.engine.tick()
    expect(r.engine.snapshot().lastError).toBe(null)
  })

  it('lets a preview change supersede a preview recovery cleanly', () => {
    const r = engineRig(cue('a'), cue('b'))
    r.engine.setMode('preview')
    r.engine.selectCue('a')
    decodeFrame(r.el('a'), 1)
    r.engine.tick()
    decodeError(r.el('a'))
    r.engine.tick()

    r.engine.selectCue('b')
    for (const element of r.elements.get('a') ?? []) expect(element.listenerCount()).toBe(0)
    r.clock.advance(60_000)
    expect(r.clock.pending()).toBe(0)
    expect(r.events.map((e) => [e.slot, e.cueId, e.kind])).toEqual([['preview', 'a', 'attempt']])
  })
})
