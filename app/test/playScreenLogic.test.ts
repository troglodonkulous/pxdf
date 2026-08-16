import { describe, expect, it } from 'vitest'
import { isGoDisabled, selectCueTarget, timelineProgress } from '../src/PlayScreen'
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
  // Once the Preview re-target was removed there is nothing left for a unit
  // test to disprove: the mode and live-cue parameters are gone, so no caller
  // can reach a target other than the clicked cue and this describe block
  // cannot fail for the reason it exists. Said plainly rather than dressed up
  // — a passing assertion here is not evidence that standby and preview agree
  // in the running app.
  //
  // That evidence is `wire.mjs` § 6i-d, which clicks rows in both modes and reads
  // the standby marker and the inspector back out of the real UI. This keeps
  // the promise stated where a future caller will read it, and keeps the export
  // honest about being total.
  it('targets exactly the clicked cue, for every cue in the show', () => {
    for (const c of cues) expect(selectCueTarget(c.id)).toBe(c.id)
  })
})
