import { describe, expect, it } from 'vitest'
import { isGoDisabled, selectCueTarget, timelineProgress } from '../src/PlayScreen'
import type { Cue } from '../src/player/show'

const cue = (id: string): Cue => ({
  id,
  name: `Cue ${id}`,
  source: { kind: 'video', path: `/media/${id}.mp4` },
  durationMs: null,
  rotation: 0,
})
const cues = [cue('cue-1'), cue('cue-2'), cue('cue-3')]

describe('isGoDisabled', () => {
  it('disables GO when nothing is standing by', () => {
    expect(isGoDisabled({ standbyCueId: null, liveCueId: 'cue-1' })).toBe(true)
  })

  it('disables GO when standby is parked on the already-live cue', () => {
    // This is the load-bearing case: without it, GO would re-fire (restart)
    // the cue that is already on the floor, for no operator-visible reason.
    expect(isGoDisabled({ standbyCueId: 'cue-1', liveCueId: 'cue-1' })).toBe(true)
  })

  it('enables GO when standby targets a distinct cue', () => {
    expect(isGoDisabled({ standbyCueId: 'cue-2', liveCueId: 'cue-1' })).toBe(false)
  })
})

describe('timelineProgress', () => {
  it('reads 0 when there is no media duration to divide by', () => {
    // The case that exposed the original bug: a hold-until-GO cue never gets
    // a durationMs, but it still has a real clip position/duration from the
    // decoder — a timeline driven by elapsedMs/cueDurationMs would freeze at
    // 0 instead of advancing.
    expect(timelineProgress({ positionMs: 4_000, mediaDurationMs: null })).toBe(0)
    expect(timelineProgress({ positionMs: 4_000, mediaDurationMs: 0 })).toBe(0)
  })

  it('reads the clip position as a fraction of the clip duration', () => {
    expect(timelineProgress({ positionMs: 2_500, mediaDurationMs: 10_000 })).toBeCloseTo(0.25)
  })

  it('clamps to [0, 1] against a position outside the clip', () => {
    expect(timelineProgress({ positionMs: -100, mediaDurationMs: 10_000 })).toBe(0)
    expect(timelineProgress({ positionMs: 20_000, mediaDurationMs: 10_000 })).toBe(1)
  })
})

describe('selectCueTarget', () => {
  it('targets exactly the clicked cue outside Preview, even when it is live', () => {
    // Load-bearing: selectedCueId (inspector/rotation/rename/move/delete)
    // must equal what was clicked in Live mode. A code-review pass caught an
    // earlier version that redirected this to the next cue unconditionally,
    // silently pointing those controls at a cue nobody clicked.
    expect(selectCueTarget('cue-1', cues, 'live', 'cue-1')).toBe('cue-1')
    expect(selectCueTarget('cue-2', cues, 'live', 'cue-1')).toBe('cue-2')
  })

  it('redirects Preview clicks on the live row to the next cue', () => {
    expect(selectCueTarget('cue-1', cues, 'preview', 'cue-1')).toBe('cue-2')
  })

  it('falls back to the clicked (live) cue in Preview when it is last in the show', () => {
    expect(selectCueTarget('cue-3', cues, 'preview', 'cue-3')).toBe('cue-3')
  })

  it('targets exactly the clicked cue in Preview when it is not live', () => {
    expect(selectCueTarget('cue-2', cues, 'preview', 'cue-1')).toBe('cue-2')
  })
})
