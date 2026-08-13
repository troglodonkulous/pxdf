import { describe, expect, it } from 'vitest'
import { probeDurationMs, type DurationProbe } from '../src/player/mediaDuration'

/**
 * A probe whose answer arrives after a set number of polls, so the test can
 * assert on *when* the loop gives up as well as on what it returns.
 *
 * The clock is driven by the fake `wait` rather than by a timer: a test that
 * waits real milliseconds for a 5 s timeout is a test nobody runs.
 */
function probe(script: { answerAfter?: number; failAfter?: number; duration?: number }) {
  let polls = 0
  let clock = 0
  const state: DurationProbe = {
    get mediaDurationMs() {
      return script.answerAfter !== undefined && polls >= script.answerAfter
        ? (script.duration ?? 4_000)
        : null
    },
    get failed() {
      return script.failAfter !== undefined && polls >= script.failAfter
    },
  }
  return {
    state,
    options: {
      timeoutMs: 5_000,
      pollMs: 50,
      now: () => clock,
      wait: async (ms: number) => {
        polls += 1
        clock += ms
      },
    },
    polls: () => polls,
  }
}

describe('probeDurationMs', () => {
  it('returns a length that is available immediately', async () => {
    const p = probe({ answerAfter: 0, duration: 12_345 })
    await expect(probeDurationMs(p.state, p.options)).resolves.toBe(12_345)
    expect(p.polls()).toBe(0)
  })

  it('waits for a length that arrives a few polls in', async () => {
    const p = probe({ answerAfter: 3, duration: 7_000 })
    await expect(probeDurationMs(p.state, p.options)).resolves.toBe(7_000)
    expect(p.polls()).toBe(3)
  })

  it('rejects when the media cannot be read', async () => {
    const p = probe({ failAfter: 2 })
    await expect(probeDurationMs(p.state, p.options)).rejects.toThrow('could not read the media')
  })

  it('prefers the failure to a length left over from a previous load', async () => {
    // A source that has failed can still be holding a duration. Returning it
    // would put a number in the show file that reads as measured and is not.
    const p = probe({ answerAfter: 0, failAfter: 0, duration: 9_000 })
    await expect(probeDurationMs(p.state, p.options)).rejects.toThrow('could not read the media')
  })

  it('gives up on a probe that never answers, rather than awaiting for ever', async () => {
    const p = probe({})
    await expect(probeDurationMs(p.state, p.options)).rejects.toThrow('timed out')
    // 5 s deadline at 50 ms a poll. The point is that it is bounded and that it
    // is the deadline doing the bounding, not a poll counter that happens to
    // run out first.
    expect(p.polls()).toBe(100)
  })

  it('believes an answer that lands exactly on the deadline', async () => {
    const p = probe({ answerAfter: 100, duration: 3_000 })
    await expect(probeDurationMs(p.state, p.options)).resolves.toBe(3_000)
  })
})
