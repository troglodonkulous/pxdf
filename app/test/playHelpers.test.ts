import { describe, expect, it } from 'vitest'
import {
  cueNameFromPath,
  formatTimecode,
  insertCue,
  moveCue,
  removeCue,
  renameCue,
  setCueRotation,
} from '../src/player/playHelpers'
import type { Cue } from '../src/player/show'

const cue = (id: string): Cue => ({
  id,
  name: `Cue ${id}`,
  source: { kind: 'video', path: `/media/${id}.mp4` },
  loop: null,
  trimStartMs: 0,
  trimEndMs: null,
  mediaDurationMs: null,
  rotation: 0,
})

describe('Play helpers', () => {
  it('formats cue durations and transport timecodes', () => {
    expect(formatTimecode(null)).toBe('∞')
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(62_999)).toBe('1:02')
    expect(formatTimecode(3_661_000)).toBe('61:01')
  })

  it('appends without mutating the original cue list', () => {
    const original = [cue('a'), cue('c')]
    const inserted = insertCue(original, cue('b'))
    expect(inserted.map(({ id }) => id)).toEqual(['a', 'c', 'b'])
    expect(original.map(({ id }) => id)).toEqual(['a', 'c'])
  })

  it('removes a cue by id', () => {
    expect(removeCue([cue('a'), cue('b'), cue('c')], 'b').map(({ id }) => id)).toEqual(['a', 'c'])
  })

  it('moves a cue one keyboard-reachable step and stops at the edges', () => {
    const cues = [cue('a'), cue('b'), cue('c')]
    expect(moveCue(cues, 'b', -1).map(({ id }) => id)).toEqual(['b', 'a', 'c'])
    expect(moveCue(cues, 'b', 1).map(({ id }) => id)).toEqual(['a', 'c', 'b'])
    expect(moveCue(cues, 'a', -1).map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  })

  it('renames non-destructively and derives readable names from media paths', () => {
    expect(renameCue([cue('a')], 'a', '  First Dance  ')[0].name).toBe('First Dance')
    expect(cueNameFromPath('/media/first-dance.mp4')).toBe('first-dance')
    expect(cueNameFromPath('C:\\Media\\open-floor.mov')).toBe('open-floor')
  })
})

// parseDurationSeconds/durationSecondsText/setCueDuration/DEFAULT_CUE_DURATION_MS
// are deleted with the v1 durationMs model (see app/src/player/show.ts's
// loop/trimStartMs/trimEndMs/mediaDurationMs and playHelpers.ts). No editing
// helper replaces setCueDuration in this PR -- the Loop/Trim editing UI is a
// later PR (docs/APP-PLAN.md); see HANDOFF.md decision 4.

describe('setCueRotation', () => {
  it('sets one cue and leaves the array it was given alone', () => {
    const original = [cue('a'), cue('b')]
    const edited = setCueRotation(original, 'b', 90)
    expect(edited[1].rotation).toBe(90)
    expect(edited[0].rotation).toBe(original[0].rotation)
    expect(original[1].rotation).not.toBe(90)
  })

  it('is independent of the floor Rotation set in Mapping', () => {
    // Cue rotation compensates one cue's own video; it is stored on the cue and
    // has no dependency on, or interaction with, App.tsx's floor `rotation`
    // state. Setting it on one cue must not touch any other cue's rotation.
    const cues = [cue('a'), cue('b'), cue('c')]
    const edited = setCueRotation(cues, 'b', 180)
    expect(edited.map((c) => c.rotation)).toEqual([0, 180, 0])
  })
})
