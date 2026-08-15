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

  it('moves a cue to an arbitrary target index', () => {
    // The signature the drag-and-drop handler needs: a drop index, not a
    // step. Dropping row 'a' onto row 'c''s position lands it at index 2.
    const cues = [cue('a'), cue('b'), cue('c'), cue('d')]
    expect(moveCue(cues, 'a', 2).map(({ id }) => id)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveCue(cues, 'd', 0).map(({ id }) => id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('still serves the keyboard up/down buttons, which pass selectedIndex ± 1', () => {
    const cues = [cue('a'), cue('b'), cue('c')]
    expect(moveCue(cues, 'b', 0).map(({ id }) => id)).toEqual(['b', 'a', 'c'])
    expect(moveCue(cues, 'b', 2).map(({ id }) => id)).toEqual(['a', 'c', 'b'])
  })

  it('clamps a target past either edge rather than refusing the move', () => {
    // A drop below the last row or above the first is an ordinary drag
    // gesture, not an error — unlike the old `-1 | 1` offset form, which
    // returned the stack unchanged at an edge because there was no next slot
    // to step into. Clamping is that same "do nothing more" outcome for the
    // in-bounds edge case (moving the first cue further up) and an active
    // move for the out-of-bounds one (a drop past the end).
    const cues = [cue('a'), cue('b'), cue('c')]
    expect(moveCue(cues, 'a', -5).map(({ id }) => id)).toEqual(['a', 'b', 'c'])
    expect(moveCue(cues, 'a', 99).map(({ id }) => id)).toEqual(['b', 'c', 'a'])
  })

  it('leaves the stack unchanged for an id that is not in it', () => {
    const cues = [cue('a'), cue('b'), cue('c')]
    expect(moveCue(cues, 'ghost', 1).map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the array it was given', () => {
    const original = [cue('a'), cue('b'), cue('c')]
    moveCue(original, 'a', 2)
    expect(original.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
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
