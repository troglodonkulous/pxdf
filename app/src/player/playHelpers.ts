import type { Cue } from './show'

export function formatTimecode(milliseconds: number | null): string {
  if (milliseconds === null) return '∞'
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function insertCue(cues: readonly Cue[], cue: Cue, index = cues.length): Cue[] {
  const insertionIndex = Math.max(0, Math.min(cues.length, Math.trunc(index)))
  return [...cues.slice(0, insertionIndex), cue, ...cues.slice(insertionIndex)]
}

export function removeCue(cues: readonly Cue[], cueId: string): Cue[] {
  return cues.filter((cue) => cue.id !== cueId)
}

export function moveCue(cues: readonly Cue[], cueId: string, offset: -1 | 1): Cue[] {
  const from = cues.findIndex((cue) => cue.id === cueId)
  const to = from + offset
  if (from < 0 || to < 0 || to >= cues.length) return [...cues]

  const moved = [...cues]
  const [cue] = moved.splice(from, 1)
  moved.splice(to, 0, cue)
  return moved
}

export function renameCue(cues: readonly Cue[], cueId: string, name: string): Cue[] {
  const trimmed = name.trim()
  if (trimmed.length === 0) return [...cues]
  return cues.map((cue) => (cue.id === cueId ? { ...cue, name: trimmed } : cue))
}

/** The length a cue gets when the operator switches it off Hold without a number. */
export const DEFAULT_CUE_DURATION_MS = 10_000

/**
 * Read the inspector's seconds field as a cue duration.
 *
 * Returns null for anything that is not a usable length, and the caller must
 * treat that as *do not write this* rather than as a value. `Cue.durationMs`
 * uses null for "hold until GO", so a parse failure and a deliberate hold are
 * the same value with opposite meanings — writing one where the other was meant
 * turns a typo into a cue that never ends, or into one that never starts.
 *
 * Every rejected case here reaches the engine as a real misbehaviour rather
 * than an error, which is why the check is at this edge:
 * `advanceOnDuration` guards with `elapsedMs() < duration`, and that comparison
 * is false for `NaN`, for `0` and for anything negative. So an unparseable
 * field would not fail loudly — it would make the cue advance on the very next
 * tick, for ever, one cue per frame, with nothing anywhere saying why.
 *
 * The rounded milliseconds are what gets tested, not the seconds. `0.0001`
 * parses as a positive finite number and rounds to `0`, which is exactly the
 * value being guarded against.
 */
export function parseDurationSeconds(text: string): number | null {
  const seconds = Number(text.trim())
  if (!Number.isFinite(seconds)) return null
  const milliseconds = Math.round(seconds * 1_000)
  return milliseconds > 0 ? milliseconds : null
}

/** The inverse, for filling the field. Empty string for a cue that holds. */
export function durationSecondsText(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return ''
  return String(Math.round(durationMs) / 1_000)
}

export function setCueDuration(cues: readonly Cue[], cueId: string, durationMs: number | null): Cue[] {
  return cues.map((cue) => (cue.id === cueId ? { ...cue, durationMs } : cue))
}

export function cueNameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? path
  const withoutExtension = filename.replace(/\.[^.]+$/, '')
  return withoutExtension.length > 0 ? withoutExtension : filename
}
