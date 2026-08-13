/**
 * The Player preview canvas's zoom multiplier, layered on top of the
 * contain-fit scale `App.tsx`'s `positionPreview` already computes. Pure and
 * DOM-free on purpose, same reasoning as `coverRect`: the step math is what a
 * test can hold still, the canvas box it ends up driving is not.
 */

import { describe, expect, it } from 'vitest'
import { clampZoom, ZOOM_FIT, ZOOM_MAX, ZOOM_MIN, zoomIn, zoomOut } from '../src/player/zoom'

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
