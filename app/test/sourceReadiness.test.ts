import { describe, expect, it } from 'vitest'
import { SourceReadiness } from '../src/player/sourceReadiness'

describe('SourceReadiness', () => {
  it('starts neither ready nor failed', () => {
    const state = new SourceReadiness()
    expect(state.ready).toBe(false)
    expect(state.failed).toBe(false)
    expect(state.disposed).toBe(false)
  })

  it('becomes ready on a decoded frame and stays ready', () => {
    const state = new SourceReadiness()
    expect(state.observe(false)).toBe(false)
    expect(state.ready).toBe(false)

    expect(state.observe(true)).toBe(true)
    expect(state.ready).toBe(true)
    // A source does not become un-ready because a later poll caught the element
    // between frames. The engine reads `ready` every tick and would drop the
    // cue off the wire mid-clip.
    expect(state.observe(false)).toBe(false)
    expect(state.ready).toBe(true)
  })

  it('answers is-ready rather than became-ready on repeat calls', () => {
    const state = new SourceReadiness()
    state.observe(true)
    // `videoSource.ts` re-arms `requestVideoFrameCallback` whenever this comes
    // back false. A transition-style return would answer false here and re-arm
    // for ever on a source that has been ready since the first frame.
    expect(state.observe(true)).toBe(true)
  })

  it('never becomes ready once it has failed', () => {
    const state = new SourceReadiness()
    state.fail()
    expect(state.observe(true)).toBe(false)
    expect(state.ready).toBe(false)
    expect(state.failed).toBe(true)
  })

  it('can fail after it was ready, and failure wins', () => {
    // The taint case: the element decodes fine and the failure is raised from
    // outside, by the composite step that could not read the pixels back.
    const state = new SourceReadiness()
    state.observe(true)
    state.fail()
    expect(state.failed).toBe(true)
    expect(state.ready).toBe(true)
  })

  it('accepts no further state once disposed', () => {
    const state = new SourceReadiness()
    expect(state.dispose()).toBe(true)

    // A disposed element fires `error` while its `src` is being removed. Taking
    // that failure would raise a banner about a cue nobody is playing.
    state.fail()
    expect(state.failed).toBe(false)
    expect(state.observe(true)).toBe(false)
    expect(state.ready).toBe(false)
  })

  it('reports the first dispose only, so teardown runs once', () => {
    const state = new SourceReadiness()
    expect(state.dispose()).toBe(true)
    expect(state.dispose()).toBe(false)
    expect(state.disposed).toBe(true)
  })
})
