/**
 * The decoder census, graded on the only failure that matters: not going down.
 *
 * A census that counts up and never comes back is not a partially working
 * instrument, it is an instrument that will report an exhaustion which never
 * happened — and by `CLAUDE.md`'s rule, a channel that cries wolf is a
 * destroyed channel. That is the direction this file pushes hardest on.
 *
 * The happy path is asserted alongside every one of those, because "always
 * reports zero" also satisfies "the count comes down". Each case pairs an
 * observation with its own disproof, so an implementation stuck in either mode
 * fails something.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { decoderCensus, openDecoder, resetDecoderCensus } from '../src/player/decoderCensus'

beforeEach(() => {
  resetDecoderCensus()
})

describe('decoderCensus', () => {
  it('starts at nothing, so a run that opened none is not a run that lost track', () => {
    expect(decoderCensus()).toEqual({ live: 0, peak: 0, opened: 0 })
  })

  it('counts up while decoders are held', () => {
    openDecoder()
    openDecoder()
    expect(decoderCensus().live).toBe(2)
    expect(decoderCensus().opened).toBe(2)
  })

  it('counts back down when they are released', () => {
    const first = openDecoder()
    const second = openDecoder()
    expect(decoderCensus().live).toBe(2)
    first()
    expect(decoderCensus().live).toBe(1)
    second()
    expect(decoderCensus().live).toBe(0)
  })

  it('releases once however many times the token is called', () => {
    // `VideoSource.dispose` is idempotent and `captureThumbnail` releases in a
    // `finally` that can run after an earlier throw, so a double release is a
    // real path and not a hypothetical. Undercounting is the dangerous
    // direction: it makes a genuine fan-out look like a quiet session, which is
    // the reading nobody investigates.
    const held = openDecoder()
    const release = openDecoder()
    release()
    release()
    release()
    expect(decoderCensus().live).toBe(1)
    held()
    expect(decoderCensus().live).toBe(0)
  })

  it('never reports fewer live decoders than zero', () => {
    const release = openDecoder()
    release()
    release()
    expect(decoderCensus().live).toBe(0)
    expect(decoderCensus().live).toBeGreaterThanOrEqual(0)
  })

  it('remembers the high-water mark after everything is released', () => {
    // The fan-out question is asked the morning after, when nothing is open any
    // more. `live` alone cannot answer it: a session that opened eighty
    // decoders at once and a session that opened none look identical by then.
    const releases = Array.from({ length: 8 }, () => openDecoder())
    expect(decoderCensus().peak).toBe(8)
    for (const release of releases) release()
    expect(decoderCensus().live).toBe(0)
    expect(decoderCensus().peak).toBe(8)
    expect(decoderCensus().opened).toBe(8)
  })

  it('does not raise the peak on serial use', () => {
    // Forty clips opened and closed one at a time is not fan-out, and a peak
    // that counted total instead of concurrent would call it that — inventing
    // the evidence for the hypothesis it exists to test.
    for (let i = 0; i < 40; i += 1) openDecoder()()
    expect(decoderCensus().peak).toBe(1)
    expect(decoderCensus().opened).toBe(40)
    expect(decoderCensus().live).toBe(0)
  })

  it('keeps live no greater than opened, whatever order tokens are called in', () => {
    const a = openDecoder()
    const b = openDecoder()
    b()
    const c = openDecoder()
    a()
    const census = decoderCensus()
    expect(census.live).toBe(1)
    expect(census.opened).toBe(3)
    expect(census.live).toBeLessThanOrEqual(census.opened)
    c()
    expect(decoderCensus().live).toBe(0)
  })
})
