import { beforeAll, describe, expect, it } from 'vitest'
import {
  DECODE_FAULT_ENV,
  DecodeFault,
  INJECTED_DECODE_MESSAGE,
  parseDecodeFault,
  type DecodeFaultSpec,
} from '../src/player/decodeFault'
import { VideoSource } from '../src/player/videoSource'

/**
 * The fault-injection seam that grades decode recovery on the wire.
 *
 * `PIPELINE_ERROR_DECODE` cannot be produced on demand: it is VideoToolbox
 * giving up on a stream, and in September it did so 116 times over eight hours
 * with no recipe. A recovery path that is only exercised when hardware happens
 * to fail is ungraded, so the seam raises the same thing the element raises —
 * `error.code === 3` and an `error` event — on a chosen clip, a chosen time
 * after it starts playing.
 *
 * What these tests hold it to:
 *  - unset is inert, and a malformed spec is a loud refusal, never "no fault"
 *    (a gate that thinks it injected and did not would grade recovery green
 *    over nothing);
 *  - `once` means once per launch, across every element and every cue;
 *  - a fault never lands on an element its source has already let go of, and
 *    an injection that hit nothing is never counted;
 *  - `VideoSource` cannot tell the injected error from a real one.
 */

class FakeMediaError {
  constructor(readonly code: number, readonly message = '') {}
}

/** Enough of an `HTMLVideoElement` for `VideoSource` and the seam both. */
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

  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, handler: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, handler: (event: Event) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event: Event): boolean {
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event)
    return true
  }

  load(): void {}
  pause(): void {}
  async play(): Promise<void> {}

  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }

  emit(type: string): void {
    this.dispatchEvent({ type } as Event)
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeClock {
  private next = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()
  now = 0

  setTimer = (run: () => void, ms: number): number => {
    const id = this.next++
    this.timers.set(id, { at: this.now + ms, run })
    return id
  }

  clearTimer = (id: unknown): void => {
    this.timers.delete(id as number)
  }

  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.now = due[1].at
      due[1].run()
    }
    this.now = until
  }

  get pending(): number {
    return this.timers.size
  }
}

const CLIP = '/clips/Animated Dice Retro.mp4'
const OTHER = '/clips/Blue Particle Trails.mp4'

interface Rig {
  fault: DecodeFault
  clock: FakeClock
  created: FakeVideoElement[]
  reports: string[]
}

function rig(spec: DecodeFaultSpec): Rig {
  const clock = new FakeClock()
  const created: FakeVideoElement[] = []
  const reports: string[] = []
  const fault = new DecodeFault(spec, (path) => reports.push(path), clock, () => {
    const element = new FakeVideoElement()
    created.push(element)
    return element as unknown as HTMLVideoElement
  })
  return { fault, clock, created, reports }
}

/** An element as `VideoSource` leaves it once it is loading: a src, and playing. */
function playing(element: HTMLVideoElement): FakeVideoElement {
  const fake = element as unknown as FakeVideoElement
  fake.src = 'pxdf-media://clip'
  fake.emit('playing')
  return fake
}

const ONCE: DecodeFaultSpec = { match: 'Animated Dice', afterMs: 2_000, mode: 'once' }

describe('parseDecodeFault', () => {
  it('names the env var the main process reads', () => {
    expect(DECODE_FAULT_ENV).toBe('PXDF_FAULT_DECODE')
  })

  it.each([undefined, ''])('is inert when the env var is %j', (raw) => {
    expect(parseDecodeFault(raw)).toEqual({ ok: true, spec: null })
  })

  it('accepts a once spec and a persistent spec', () => {
    expect(parseDecodeFault('{"match":"Dice","afterMs":1500,"mode":"once"}')).toEqual({
      ok: true,
      spec: { match: 'Dice', afterMs: 1_500, mode: 'once' },
    })
    expect(parseDecodeFault('{"match":"Dice","afterMs":0,"mode":"persistent"}')).toEqual({
      ok: true,
      spec: { match: 'Dice', afterMs: 0, mode: 'persistent' },
    })
  })

  /**
   * Silence must be distinguishable from success. A gate run whose spec was
   * mistyped would otherwise inject nothing and grade recovery as working.
   */
  it.each([
    ['not json', 'once:2000:Dice'],
    ['not an object', '"Dice"'],
    ['null', 'null'],
    ['missing match', '{"afterMs":2000,"mode":"once"}'],
    ['empty match', '{"match":"  ","afterMs":2000,"mode":"once"}'],
    ['negative afterMs', '{"match":"Dice","afterMs":-1,"mode":"once"}'],
    ['non-finite afterMs', '{"match":"Dice","afterMs":"soon","mode":"once"}'],
    ['unknown mode', '{"match":"Dice","afterMs":2000,"mode":"twice"}'],
  ])('refuses a malformed spec (%s) with a reason, never as "no fault"', (_label, raw) => {
    const parsed = parseDecodeFault(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toMatch(/PXDF_FAULT_DECODE/)
  })
})

describe('DecodeFault', () => {
  it('leaves a clip that does not match alone', () => {
    const r = rig(ONCE)
    expect(r.fault.elementsFor(OTHER)).toBe(null)
    expect(r.created).toHaveLength(0)
  })

  it('raises a code 3 error event on a matching clip, afterMs after it starts playing', () => {
    const r = rig(ONCE)
    const make = r.fault.elementsFor(CLIP)
    expect(make).not.toBe(null)
    const element = playing(make!())
    const errors: Event[] = []
    element.addEventListener('error', (event) => errors.push(event))

    r.clock.advance(1_999)
    expect(errors).toHaveLength(0)
    expect(element.error).toBe(null)

    r.clock.advance(1)
    expect(errors).toHaveLength(1)
    expect(element.error?.code).toBe(3)
    expect(element.error?.message).toBe(INJECTED_DECODE_MESSAGE)
    expect(r.fault.injected).toBe(1)
    expect(r.reports).toEqual([CLIP])
  })

  it('does not start the clock before the element plays', () => {
    const r = rig(ONCE)
    r.fault.elementsFor(CLIP)!()
    r.clock.advance(60_000)
    expect(r.fault.injected).toBe(0)
    expect(r.clock.pending).toBe(0)
  })

  it('arms once per element, however many times it resumes playing', () => {
    const r = rig({ ...ONCE, mode: 'persistent' })
    const element = playing(r.fault.elementsFor(CLIP)!())
    element.emit('playing')
    element.emit('playing')
    r.clock.advance(2_000)
    expect(r.fault.injected).toBe(1)
  })

  /**
   * `once` is the one-shot a recovering source must ride out. If the
   * replacement element faulted too, "recovers from one error" would be
   * graded against a persistent fault instead.
   */
  it('once: the replacement element, and every later cue of the clip, play clean', () => {
    const r = rig(ONCE)
    const make = r.fault.elementsFor(CLIP)!
    playing(make())
    r.clock.advance(2_000)
    expect(r.fault.injected).toBe(1)

    const replacement = playing(make())
    const laterCue = playing(r.fault.elementsFor(CLIP)!())
    r.clock.advance(60_000)
    expect(replacement.error).toBe(null)
    expect(laterCue.error).toBe(null)
    expect(r.fault.injected).toBe(1)
  })

  it('persistent: every element of the clip faults', () => {
    const r = rig({ ...ONCE, mode: 'persistent', afterMs: 500 })
    const make = r.fault.elementsFor(CLIP)!
    const elements = [playing(make()), playing(make()), playing(make())]
    r.clock.advance(500)
    expect(elements.map((e) => e.error?.code)).toEqual([3, 3, 3])
    expect(r.fault.injected).toBe(3)
    expect(r.reports).toEqual([CLIP, CLIP, CLIP])
  })

  /**
   * A cue taken off the floor before the timer fires releases its element
   * (`removeAttribute('src')`). Faulting it would hit nothing, and counting it
   * would let a gate read "1 injected" over a run where the fault never
   * reached a live source — so it is skipped, uncounted, and `once` is still
   * unspent for the next cue of the clip.
   */
  it('skips an element its source has released, without spending once', () => {
    const r = rig(ONCE)
    const make = r.fault.elementsFor(CLIP)!
    const released = playing(make())
    released.removeAttribute('src')
    r.clock.advance(2_000)
    expect(released.error).toBe(null)
    expect(r.fault.injected).toBe(0)
    expect(r.reports).toEqual([])

    const next = playing(make())
    r.clock.advance(2_000)
    expect(next.error?.code).toBe(3)
    expect(r.fault.injected).toBe(1)
  })

  it('matches on a substring of the path', () => {
    const r = rig({ ...ONCE, match: 'Dice Retro.mp4' })
    expect(r.fault.elementsFor(CLIP)).not.toBe(null)
    expect(r.fault.elementsFor('/clips/Dice.mp4')).toBe(null)
  })
})

/**
 * The consequence on stock main: the injected error is indistinguishable from
 * a real one, so a ready source fails with the decode reason and the floor
 * goes black — the September behaviour, which is the control arm a recovery
 * branch is graded against.
 */
describe('DecodeFault through VideoSource', () => {
  beforeAll(() => {
    const globals = globalThis as unknown as { HTMLMediaElement?: unknown }
    globals.HTMLMediaElement ??= { HAVE_CURRENT_DATA: 2 }
  })

  it('fails a ready source with the decode reason, as a real PIPELINE_ERROR_DECODE does', () => {
    const r = rig(ONCE)
    const make = r.fault.elementsFor(CLIP)!
    const element = make() as unknown as FakeVideoElement
    const source = new VideoSource(CLIP, 0, { trimStartMs: 0, trimEndMs: null }, element as unknown as HTMLVideoElement)
    expect(element.src).not.toBe('')
    expect(element.count('error')).toBeGreaterThan(0)

    element.readyState = 2
    element.videoWidth = 768
    element.videoHeight = 640
    element.emit('loadeddata')
    expect(source.ready).toBe(true)

    element.emit('playing')
    r.clock.advance(2_000)
    expect(r.fault.injected).toBe(1)
    expect(source.failed).toBe(true)
    expect(source.failureReason).toContain('code 3')
    expect(source.failureReason).toContain(INJECTED_DECODE_MESSAGE)
  })

  it('does nothing to a source disposed before the timer fires', () => {
    const r = rig(ONCE)
    const element = r.fault.elementsFor(CLIP)!() as unknown as FakeVideoElement
    const source = new VideoSource(CLIP, 0, { trimStartMs: 0, trimEndMs: null }, element as unknown as HTMLVideoElement)
    element.emit('playing')
    source.dispose()
    r.clock.advance(2_000)
    expect(r.fault.injected).toBe(0)
    expect(source.failed).toBe(false)
  })
})
