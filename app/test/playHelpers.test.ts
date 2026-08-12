import { describe, expect, it } from 'vitest'
import { cueNameFromPath, formatTimecode, insertCue, moveCue, removeCue, renameCue } from '../src/player/playHelpers'
import type { Cue } from '../src/player/show'

const cue = (id: string): Cue => ({
  id,
  name: `Cue ${id}`,
  source: { kind: 'video', path: `/media/${id}.mp4` },
  durationMs: null,
})

describe('Play helpers', () => {
  it('formats cue durations and transport timecodes', () => {
    expect(formatTimecode(null)).toBe('∞')
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(62_999)).toBe('1:02')
    expect(formatTimecode(3_661_000)).toBe('61:01')
  })

  it('inserts without mutating the original cue list', () => {
    const original = [cue('a'), cue('c')]
    const inserted = insertCue(original, cue('b'), 1)
    expect(inserted.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
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
