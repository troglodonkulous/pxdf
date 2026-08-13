import { describe, expect, it } from 'vitest'
import {
  cueNameFromPath,
  durationSecondsText,
  formatTimecode,
  insertCue,
  moveCue,
  parseDurationSeconds,
  removeCue,
  renameCue,
  setCueDuration,
} from '../src/player/playHelpers'
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

/**
 * The duration field is a text input wired to a number the render loop reads
 * sixty times a second, and the engine's duration check is `elapsedMs() <
 * duration`. That comparison is false for `NaN`, for `0` and for negatives — so
 * every value rejected here would otherwise produce a cue that advances on the
 * next tick and every tick after it, walking the whole stack in under a second
 * with no error raised anywhere. This is the edge where that is catchable.
 */
describe('parseDurationSeconds', () => {
  it('reads a plain number of seconds', () => {
    expect(parseDurationSeconds('10')).toBe(10_000)
    expect(parseDurationSeconds(' 2.5 ')).toBe(2_500)
    expect(parseDurationSeconds('0.5')).toBe(500)
  })

  it.each([
    ['', 'an empty field, which Number() reads as 0'],
    ['   ', 'whitespace, likewise'],
    ['abc', 'text'],
    ['NaN', 'the literal'],
    ['0', 'zero, which advances every tick'],
    ['-4', 'a negative, which is already spent'],
    ['Infinity', 'a duration that never elapses but is not a hold'],
    ['1e400', 'an overflow to Infinity'],
  ])('rejects %s (%s)', (text) => {
    expect(parseDurationSeconds(text)).toBe(null)
  })

  it('rejects a positive number that rounds away to nothing', () => {
    // The guard has to be on the milliseconds, not the seconds: 0.0001 is
    // finite and positive and still produces a duration of 0.
    expect(parseDurationSeconds('0.0001')).toBe(null)
    expect(parseDurationSeconds('0.001')).toBe(1)
  })

  it('round-trips through the field text', () => {
    for (const milliseconds of [1_000, 2_500, 90_000, 1]) {
      expect(parseDurationSeconds(durationSecondsText(milliseconds))).toBe(milliseconds)
    }
  })

  it('shows an empty field for a cue that holds', () => {
    expect(durationSecondsText(null)).toBe('')
    // Not a number the field could round-trip into a duration, so it must read
    // as empty rather than as `0`, which the operator would take for a value.
    expect(durationSecondsText(0)).toBe('')
    expect(durationSecondsText(Number.NaN)).toBe('')
  })
})

describe('setCueDuration', () => {
  it('sets one cue and leaves the array it was given alone', () => {
    const original = [cue('a'), cue('b')]
    const edited = setCueDuration(original, 'b', 4_000)
    expect(edited[1].durationMs).toBe(4_000)
    expect(edited[0].durationMs).toBe(original[0].durationMs)
    expect(original[1].durationMs).not.toBe(4_000)
  })

  it('writes null for a cue that holds until GO', () => {
    expect(setCueDuration([{ ...cue('a'), durationMs: 4_000 }], 'a', null)[0].durationMs).toBe(null)
  })
})
