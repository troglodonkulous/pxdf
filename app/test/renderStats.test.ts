/**
 * The heartbeat's renderer field, graded on the three ways it can be silent.
 *
 * This is the field with the most scope in the app to lie by omission, so most
 * of what is below is about the cases where there is nothing to report. A
 * renderer that has never spoken, a renderer that spoke and stopped, and a
 * renderer that is healthy but idle are three different conditions with three
 * different responses from the reader, and all three would print `0` under the
 * obvious implementation.
 *
 * Every "says the bad thing" case is paired with the healthy case it has to be
 * distinguishable from. A formatter that always printed `SILENT` would satisfy
 * half of these on its own.
 */

import { describe, it, expect } from 'vitest'
import {
  emptyRenderWindow,
  foldRenderSample,
  renderField,
  rollRenderWindow,
  type RenderSample,
} from '../electron/renderStats'

function sample(overrides: Partial<RenderSample> = {}): RenderSample {
  return {
    composes: 8,
    drawMsTotal: 1.6,
    readbackMsTotal: 16,
    passMsTotal: 8,
    drawMsMax: 0.5,
    readbackMsMax: 4,
    passMsMax: 1.5,
    decodersLive: 3,
    decodersPeak: 41,
    decodersOpened: 152,
    ...overrides,
  }
}

describe('renderField', () => {
  it('says so when no renderer has ever reported', () => {
    // The single most important line in this file. Before a window loads, and
    // after the last one closes, there is genuinely nothing to say — and `0`
    // or an absent field would both read as a healthy renderer sitting idle,
    // which is the exact silence-reads-as-success failure the heartbeat exists
    // to remove.
    expect(renderField(emptyRenderWindow(), 1_000)).toBe('renderer=never-reported')
  })

  it('never returns an empty string', () => {
    // A missing field is the one reading a log's reader cannot tell from a
    // healthy one, because it looks like a line from an older build.
    const states = [
      emptyRenderWindow(),
      foldRenderSample(emptyRenderWindow(), sample(), 1_000),
      rollRenderWindow(foldRenderSample(emptyRenderWindow(), sample(), 1_000)),
    ]
    for (const state of states) {
      expect(renderField(state, 100_000).length).toBeGreaterThan(0)
      expect(renderField(state, 100_000)).toContain('renderer=')
    }
  })

  it('reports a fresh sample as live, with the numbers in it', () => {
    const window = foldRenderSample(emptyRenderWindow(), sample(), 1_000)
    const field = renderField(window, 1_200)
    expect(field).toContain('renderer=live')
    expect(field).toContain('composes=8')
    expect(field).toContain('draw=0.20/0.50ms')
    expect(field).toContain('readback=2.00/4.00ms')
    expect(field).toContain('pass=1.00/1.50ms')
    expect(field).toContain('decoders=3')
    expect(field).toContain('peak=41')
    expect(field).toContain('opened=152')
  })

  it('turns SILENT when the samples stop, and says how long ago', () => {
    const window = foldRenderSample(emptyRenderWindow(), sample(), 1_000)
    // Same window, read a minute later with nothing folded in since.
    const field = renderField(rollRenderWindow(window), 61_000)
    expect(field).toContain('renderer=SILENT')
    expect(field).toContain('age=60.0s')
    // Upper case, and different from both other states, so a grep for one
    // condition cannot accidentally match another.
    expect(field).not.toContain('renderer=live')
    expect(field).not.toContain('never-reported')
  })

  it('does not call a renderer SILENT for one late sample', () => {
    // The cry-wolf half. 2 s is eight missed samples; a garbage collection, a
    // cue change or a window drag must not reach it.
    const window = foldRenderSample(emptyRenderWindow(), sample(), 1_000)
    expect(renderField(window, 2_900)).toContain('renderer=live')
    expect(renderField(window, 3_100)).toContain('renderer=SILENT')
  })

  it('remembers what the renderer was holding when it went quiet', () => {
    // A SILENT renderer's last known decoder count is the most useful number in
    // the line — it is what it was holding at the moment it stopped. Degrading
    // to `never-reported` here would throw exactly that away.
    const window = rollRenderWindow(foldRenderSample(emptyRenderWindow(), sample(), 1_000))
    const field = renderField(window, 61_000)
    expect(field).toContain('decoders=3')
    expect(field).toContain('peak=41')
  })

  it('prints a dash, never a zero, for a window that composed nothing', () => {
    // An idle show composes no frames. `0.00ms` would claim an instantaneous
    // readback was measured when nothing was measured at all, and that number
    // would then be the evidence somebody cited for the readback being cheap.
    const idle = foldRenderSample(emptyRenderWindow(), sample({
      composes: 0,
      drawMsTotal: 0,
      readbackMsTotal: 0,
      passMsTotal: 0,
      drawMsMax: 0,
      readbackMsMax: 0,
      passMsMax: 0,
    }), 1_000)
    const field = renderField(idle, 1_100)
    expect(field).toContain('renderer=live')
    expect(field).toContain('composes=0')
    expect(field).toContain('draw=-/-ms')
    expect(field).toContain('readback=-/-ms')
    expect(field).toContain('pass=-/-ms')
    expect(field).not.toContain('0.00')
  })
})

describe('the heartbeat window', () => {
  it('weights by frames rather than averaging averages', () => {
    // A minute is 240 samples and they do not all see the same number of
    // frames. Sums and counts cross the IPC boundary precisely so a sample that
    // saw four frames does not get the same say as one that saw fifteen.
    const busy = sample({ composes: 15, readbackMsTotal: 150, readbackMsMax: 12 })
    const quiet = sample({ composes: 1, readbackMsTotal: 1, readbackMsMax: 1 })
    let window = foldRenderSample(emptyRenderWindow(), busy, 1_000)
    window = foldRenderSample(window, quiet, 1_250)

    expect(window.composes).toBe(16)
    // 151 / 16 = 9.4375, not the 5.5 an average of the two averages would give.
    expect(renderField(window, 1_300)).toContain('readback=9.44/12.00ms')
  })

  it('keeps the worst frame of the window, not the worst of the last sample', () => {
    let window = foldRenderSample(emptyRenderWindow(), sample({ readbackMsMax: 40 }), 1_000)
    window = foldRenderSample(window, sample({ readbackMsMax: 2 }), 1_250)
    // A mean of 2 ms with a 40 ms worst case is a different machine from a flat
    // 2 ms, and the mean alone cannot tell them apart.
    expect(renderField(window, 1_300)).toContain('/40.00ms')
  })

  it('starts each heartbeat window empty but not amnesiac', () => {
    const window = rollRenderWindow(foldRenderSample(emptyRenderWindow(), sample(), 1_000))
    expect(window.composes).toBe(0)
    expect(window.readbackMsMax).toBe(0)
    // ...while `last` survives, or a broken renderer would reset itself to a
    // clean-looking `never-reported` once a minute for the rest of the session.
    expect(window.last).not.toBe(null)
    expect(window.lastAt).toBe(1_000)
  })

  it('goes back to never-reported only when told to forget the renderer', () => {
    // `main.ts` calls `emptyRenderWindow` on last-window-close and on page
    // load, which are the two moments the decoders really are gone.
    expect(renderField(emptyRenderWindow(), 99_000)).toBe('renderer=never-reported')
  })
})
