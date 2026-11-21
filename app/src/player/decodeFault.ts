/**
 * A test seam that raises a decode error on a chosen clip, so decode recovery
 * can be graded on the wire.
 *
 * `PIPELINE_ERROR_DECODE` cannot be produced on demand. It is VideoToolbox
 * giving up on a stream: September's job raised it 116 times in eight hours,
 * and no file reproduces it at will. A recovery path that only runs when the
 * hardware happens to fail is ungraded, so this raises what the element itself
 * raises — `error.code === 3` and an `error` event — on a clip whose path
 * contains `match`, `afterMs` after that element first fires `playing`.
 *
 * In the same family as `PXDF_PICK_MEDIA` and `PXDF_CUE_SEED`: set by a gate,
 * inert when unset. Two things make it safer than those, because a fault left
 * on during a show would black a live cue:
 *  - the main process never hands it to a packaged build;
 *  - every launch that has it on says so in the log, and every injection is
 *    its own log line, so a show log cannot carry a fault silently and a gate
 *    can count the injections it asked for.
 *
 * A malformed spec is a refusal with a reason, never "no fault": a gate whose
 * spec was mistyped would otherwise inject nothing and grade recovery green.
 */

export const DECODE_FAULT_ENV = 'PXDF_FAULT_DECODE'

/** The message the injected `MediaError` carries; the log and the gates match on it. */
export const INJECTED_DECODE_MESSAGE = 'PIPELINE_ERROR_DECODE: injected by PXDF_FAULT_DECODE'

export interface DecodeFaultSpec {
  /** A substring of the cue's media path. */
  match: string
  /** Milliseconds after the element's first `playing` event. */
  afterMs: number
  /**
   * `once`: the first element of a matching clip to reach `afterMs` faults,
   * once per launch, and nothing after it does — the one-shot a recovering
   * source must ride out. `persistent`: every element of the clip faults,
   * replacements included — what exhausts a recovery.
   */
  mode: 'once' | 'persistent'
}

export type DecodeFaultParse = { ok: true; spec: DecodeFaultSpec | null } | { ok: false; reason: string }

export function parseDecodeFault(raw: string | undefined): DecodeFaultParse {
  if (raw === undefined || raw.length === 0) return { ok: true, spec: null }
  const refuse = (why: string): DecodeFaultParse => ({ ok: false, reason: `${DECODE_FAULT_ENV} refused: ${why}` })
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return refuse(`not JSON: ${JSON.stringify(raw)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('not a JSON object')
  const { match, afterMs, mode } = value as Record<string, unknown>
  if (typeof match !== 'string' || match.trim().length === 0) return refuse('"match" must be a non-empty string')
  if (typeof afterMs !== 'number' || !Number.isFinite(afterMs) || afterMs < 0) {
    return refuse('"afterMs" must be a finite number >= 0')
  }
  if (mode !== 'once' && mode !== 'persistent') return refuse('"mode" must be "once" or "persistent"')
  return { ok: true, spec: { match, afterMs, mode } }
}

export interface DecodeFaultClock {
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

const realClock: DecodeFaultClock = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class DecodeFault {
  private spent = false
  private count = 0

  constructor(
    private readonly spec: DecodeFaultSpec,
    /** Called once per injection that reached an element still in use. */
    private readonly report: (path: string) => void,
    private readonly clock: DecodeFaultClock = realClock,
    private readonly create: () => HTMLVideoElement = () => document.createElement('video'),
  ) {}

  /** Injections that landed. A gate asserts this against what it asked for. */
  get injected(): number {
    return this.count
  }

  /**
   * An element factory for this clip, or `null` when the clip does not match,
   * so the caller keeps its own defaults and nothing about an unmatched cue
   * changes.
   */
  elementsFor(path: string): (() => HTMLVideoElement) | null {
    if (!path.includes(this.spec.match)) return null
    return () => this.arm(this.create(), path)
  }

  private arm(element: HTMLVideoElement, path: string): HTMLVideoElement {
    let armed = false
    element.addEventListener('playing', () => {
      if (armed || (this.spec.mode === 'once' && this.spent)) return
      armed = true
      this.clock.setTimer(() => this.fire(element, path), this.spec.afterMs)
    })
    return element
  }

  private fire(element: HTMLVideoElement, path: string): void {
    if (this.spec.mode === 'once' && this.spent) return
    // Released by its source (`VideoSource.releaseElement` clears `src`). A
    // fault here would reach nothing, and counting it would let a gate read an
    // injection over a run where none reached a live cue.
    if (element.src === '') return
    this.spent = true
    this.count += 1
    Object.defineProperty(element, 'error', {
      configurable: true,
      get: () => ({ code: 3, message: INJECTED_DECODE_MESSAGE }),
    })
    this.report(path)
    element.dispatchEvent(new Event('error'))
  }
}
