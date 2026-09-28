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
    state.fail('MEDIA_ERR_DECODE (code 3)')
    expect(state.observe(true)).toBe(false)
    expect(state.ready).toBe(false)
    expect(state.failed).toBe(true)
  })

  it('can fail after it was ready, and failure wins', () => {
    // The taint case: the element decodes fine and the failure is raised from
    // outside, by the composite step that could not read the pixels back.
    const state = new SourceReadiness()
    state.observe(true)
    state.fail('SecurityError: tainted canvas')
    expect(state.failed).toBe(true)
    expect(state.ready).toBe(true)
  })

  it('accepts no further state once disposed', () => {
    const state = new SourceReadiness()
    expect(state.dispose()).toBe(true)

    // A disposed element fires `error` while its `src` is being removed. Taking
    // that failure would raise a banner about a cue nobody is playing.
    state.fail('MEDIA_ERR_ABORTED (code 1)')
    expect(state.failed).toBe(false)
    expect(state.failureReason).toBe(null)
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

/**
 * The reason a source is dead, which is the whole of what the operator used to
 * be denied. Before this, `failed` was one bit and the banner said "failed".
 */
describe('SourceReadiness failure reasons', () => {
  it('has no reason until it has failed, and a reason whenever it has', () => {
    const state = new SourceReadiness()
    expect(state.failureReason).toBe(null)

    state.fail('MEDIA_ERR_SRC_NOT_SUPPORTED (code 4): DEMUXER_ERROR_COULD_NOT_OPEN')
    // The invariant the banner rests on: `failed` true implies a reason. An
    // implementation that set the flag without the string would still satisfy
    // `failed`, and would put the empty banner back.
    expect(state.failed).toBe(true)
    expect(state.failureReason).toBe('MEDIA_ERR_SRC_NOT_SUPPORTED (code 4): DEMUXER_ERROR_COULD_NOT_OPEN')
  })

  it('keeps the first reason, not the last', () => {
    // Failures cascade. The decode dies, and the next `draw` finds nothing to
    // draw and reports a second, downstream failure. Keeping the later one
    // would trade the diagnosis for the symptom it caused — the operator gets
    // "the frame could not be drawn" for a file with the wrong codec.
    const state = new SourceReadiness()
    state.fail('MEDIA_ERR_DECODE (code 3): decoder initialization failed')
    state.fail('the decoded frame could not be drawn: InvalidStateError')
    expect(state.failureReason).toBe('MEDIA_ERR_DECODE (code 3): decoder initialization failed')
  })
})

/**
 * Buffering, which had no channel at all: a clip that plays, halts for four
 * seconds and resumes was indistinguishable from one playing perfectly, in
 * every field the engine published.
 */
describe('SourceReadiness stalls', () => {
  it('raises and clears a stall without ever becoming a failure', () => {
    const state = new SourceReadiness()
    state.observe(true)
    expect(state.stallReason).toBe(null)

    state.stall('playback', 'clip is buffering (waiting)')
    expect(state.stallReason).toBe('clip is buffering (waiting)')
    // The distinction the whole field exists for. A stall that set `failed`
    // would take the cue off the wire for a clip that was about to recover.
    expect(state.failed).toBe(false)
    expect(state.ready).toBe(true)

    state.clearStall('playback')
    expect(state.stallReason).toBe(null)
  })

  it('does not let either condition clear the other', () => {
    // The two ways this goes wrong, in one test, because they are the same
    // mistake read in opposite directions.
    //
    // A fetch stall cleared by `playing`/`canplay` is the stuck-on case: a
    // download that goes quiet while the element plays on from its buffer
    // crosses no playback threshold at all, so nothing playback-shaped ever
    // arrives to take the warning down and it stays up for the rest of the
    // show. A playback stall cleared by `progress` is the opposite — bytes
    // arriving into a buffer the floor is still frozen behind, reported as
    // recovery the operator can see is not true.
    const fetchStall = new SourceReadiness()
    fetchStall.stall('fetch', 'clip is buffering (stalled)')
    fetchStall.clearStall('playback')
    expect(fetchStall.stallReason).toBe('clip is buffering (stalled)')
    fetchStall.clearStall('fetch')
    expect(fetchStall.stallReason).toBe(null)

    const playbackStall = new SourceReadiness()
    playbackStall.stall('playback', 'clip is buffering (waiting)')
    playbackStall.clearStall('fetch')
    expect(playbackStall.stallReason).toBe('clip is buffering (waiting)')
    playbackStall.clearStall('playback')
    expect(playbackStall.stallReason).toBe(null)
  })

  it('reports the halted floor when both conditions hold at once', () => {
    // The ordinary shape of a real stall: the fetch goes quiet, then playback
    // runs out of buffer. Both are true, one line is available, and the one
    // worth reading is the one describing what the operator can see.
    const state = new SourceReadiness()
    state.stall('fetch', 'clip is buffering (stalled)')
    state.stall('playback', 'clip is buffering (waiting)')
    expect(state.stallReason).toBe('clip is buffering (waiting)')

    // And the fetch condition survives underneath it: playback resuming off a
    // buffer that is still not filling is not the end of the stall.
    state.clearStall('playback')
    expect(state.stallReason).toBe('clip is buffering (stalled)')
  })

  it('drops the stall when the source fails, rather than reporting both', () => {
    // A dead source is not a buffering one, and offering the operator both
    // readings of one cue puts the recoverable one in front of them.
    const state = new SourceReadiness()
    state.stall('fetch', 'clip is buffering (stalled)')
    state.stall('playback', 'clip is buffering (waiting)')
    state.fail('MEDIA_ERR_NETWORK (code 2)')
    expect(state.stallReason).toBe(null)
    expect(state.failureReason).toBe('MEDIA_ERR_NETWORK (code 2)')
  })

  it('ignores a stall raised after failure or teardown', () => {
    // Both fire in the ordinary course of things: an element that has failed
    // goes on emitting `stalled` as its fetch gives up, and disposal empties
    // the `src`, which does the same. Either would leave a warning up about a
    // cue that is dead or gone.
    const failed = new SourceReadiness()
    failed.fail('MEDIA_ERR_DECODE (code 3)')
    failed.stall('fetch', 'clip is buffering (stalled)')
    failed.stall('playback', 'clip is buffering (waiting)')
    expect(failed.stallReason).toBe(null)

    const disposed = new SourceReadiness()
    disposed.dispose()
    disposed.stall('fetch', 'clip is buffering (stalled)')
    disposed.stall('playback', 'clip is buffering (waiting)')
    expect(disposed.stallReason).toBe(null)
  })
})
