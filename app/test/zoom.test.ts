/**
 * The Player preview canvas's zoom multiplier, layered on top of the
 * contain-fit scale `App.tsx`'s `positionPreview` already computes. Pure and
 * DOM-free on purpose, same reasoning as `coverRect`: the step math is what a
 * test can hold still, the canvas box it ends up driving is not.
 */

import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  parseZoomPercent,
  ZOOM_FIT,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomIn,
  zoomOut,
  zoomPercentText,
} from '../src/player/zoom'

describe('zoom', () => {
  it('is 1 at fit, so the multiplier is a no-op until the operator touches it', () => {
    expect(ZOOM_FIT).toBe(1)
  })

  it('steps in and back out to the same value', () => {
    const zoomedIn = zoomIn(ZOOM_FIT)
    expect(zoomedIn).toBeGreaterThan(ZOOM_FIT)
    expect(zoomOut(zoomedIn)).toBeCloseTo(ZOOM_FIT)
  })

  it('steps out and back in to the same value', () => {
    const zoomedOut = zoomOut(ZOOM_FIT)
    expect(zoomedOut).toBeLessThan(ZOOM_FIT)
    expect(zoomIn(zoomedOut)).toBeCloseTo(ZOOM_FIT)
  })

  it('stops at the floor rather than going to 0 or negative', () => {
    let zoom = ZOOM_FIT
    for (let i = 0; i < 50; i++) zoom = zoomOut(zoom)
    expect(zoom).toBe(ZOOM_MIN)
  })

  it('stops at the ceiling rather than growing without bound', () => {
    let zoom = ZOOM_FIT
    for (let i = 0; i < 50; i++) zoom = zoomIn(zoom)
    expect(zoom).toBe(ZOOM_MAX)
  })

  it('clamps an out-of-range value from either direction', () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX)
    expect(clampZoom(-5)).toBe(ZOOM_MIN)
    expect(clampZoom(0)).toBe(ZOOM_MIN)
    expect(clampZoom(1)).toBe(1)
  })
})

/**
 * The editable percent readout. `zoom.ts` owned no text before this PR — the
 * readout was `Math.round(zoom * 100)}%`, formatted inline and never parsed
 * back — so this is new surface, not a regression guard on existing code.
 */
describe('zoom percent parsing', () => {
  it('formats the current zoom as a whole-number percent, no % sign', () => {
    expect(zoomPercentText(1)).toBe('100')
    expect(zoomPercentText(0.5)).toBe('50')
    expect(zoomPercentText(4)).toBe('400')
  })

  it('parses digits-only input into the multiplier it names', () => {
    expect(parseZoomPercent('150')).toBeCloseTo(1.5)
    expect(parseZoomPercent('100')).toBe(1)
  })

  it('clamps a parseable percent outside the range rather than rejecting it', () => {
    // An operator overshoot, not a typo -- every other zoom entry point
    // (zoomIn/zoomOut, the +/- buttons) already clamps silently rather than
    // refusing, and this field would be the odd one out if it alone bounced
    // a value back as an error.
    expect(parseZoomPercent('999')).toBe(ZOOM_MAX)
    expect(parseZoomPercent('1')).toBe(ZOOM_MIN)
  })

  it('rejects unparseable input rather than guessing at it', () => {
    // Each of these is a state the field passes through while the operator is
    // still typing, or a value with no usable reading -- '0' most of all,
    // since 0% is not a zoom level a floor preview can be shown at, and
    // silently substituting the last good zoom for it would be indistinguishable
    // from the field having accepted it.
    expect(parseZoomPercent('')).toBeNull()
    expect(parseZoomPercent('abc')).toBeNull()
    expect(parseZoomPercent('12.5')).toBeNull()
    expect(parseZoomPercent('-50')).toBeNull()
    expect(parseZoomPercent('0')).toBeNull()
    expect(parseZoomPercent('  ')).toBeNull()
  })

  it('round-trips a formatted zoom back through the parser', () => {
    // The pair only means something together: formatting alone cannot prove
    // the parser reads its own output, and parsing alone cannot prove the
    // formatter never emits something the parser would reject.
    for (const zoom of [ZOOM_MIN, 0.5, 1, 1.5, 2, ZOOM_MAX]) {
      expect(parseZoomPercent(zoomPercentText(zoom))).toBeCloseTo(zoom, 2)
    }
  })
})
