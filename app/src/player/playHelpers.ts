import type { Cue } from './show'
import type { Rotation } from '../render/geometry'

export function formatTimecode(milliseconds: number | null): string {
  if (milliseconds === null) return '∞'
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * Append a cue.
 *
 * Took an `index` once, with clamping and truncation for a value no caller ever
 * passed — `addMedia` appends, and reordering is `moveCue`'s job. Insert-at
 * belongs to the drag-and-drop PR 4 does not have yet, and it can have this
 * signature back when something calls it.
 */
export function insertCue(cues: readonly Cue[], cue: Cue): Cue[] {
  return [...cues, cue]
}

export function removeCue(cues: readonly Cue[], cueId: string): Cue[] {
  return cues.filter((cue) => cue.id !== cueId)
}

/**
 * Move a cue to an arbitrary target index, clamped to the stack's bounds.
 *
 * Generalised from a `-1 | 1` step so drag-and-drop can hand this a drop
 * index directly rather than the caller walking `moveCue` one step at a time
 * — a multi-position drag would otherwise mean the drop handler re-deriving
 * `cueId`'s new neighbours itself, in a second place that could disagree with
 * this one about what "one step" means.
 *
 * Clamping rather than refusing an out-of-range `to` keeps the keyboard
 * up/down buttons' existing behaviour unchanged: `moveSelected` passes
 * `selectedIndex - 1` at the top of the stack, which clamps back to
 * `selectedIndex`, a no-op — the same "stops at the edges" it always did. A
 * drop past the last row clamps to the end instead, which is the drag
 * gesture's ordinary meaning for "drop below everything."
 */
export function moveCue(cues: readonly Cue[], cueId: string, to: number): Cue[] {
  const from = cues.findIndex((cue) => cue.id === cueId)
  if (from < 0) return [...cues]

  const target = Math.max(0, Math.min(cues.length - 1, to))
  if (target === from) return [...cues]

  const moved = [...cues]
  const [cue] = moved.splice(from, 1)
  moved.splice(target, 0, cue)
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

export function setCueRotation(cues: readonly Cue[], cueId: string, rotation: Rotation): Cue[] {
  return cues.map((cue) => (cue.id === cueId ? { ...cue, rotation } : cue))
}

/**
 * A cue's display name, from the file the operator chose.
 *
 * The last fallback is not padding. `parseShow` refuses an empty `name`, so a
 * path whose last segment is empty — a trailing separator, or an empty entry in
 * the delimiter-split `DDF_PICK_MEDIA` the wire gate seeds — would otherwise
 * build a cue the app can hold and cannot reopen: Save writes it, Open rejects
 * the whole file, and the cue that caused it is one line in a stack of thirty.
 * A visible placeholder is the cheaper failure, and it is one the operator can
 * fix with Rename. `show.test.ts` grades this against the parser directly.
 */
export function cueNameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? path
  const withoutExtension = filename.replace(/\.[^.]+$/, '')
  return withoutExtension || filename || 'Untitled cue'
}
