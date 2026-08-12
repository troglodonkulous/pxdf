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

export function cueNameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) ?? path
  const withoutExtension = filename.replace(/\.[^.]+$/, '')
  return withoutExtension.length > 0 ? withoutExtension : filename
}
