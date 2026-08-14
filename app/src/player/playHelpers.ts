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
