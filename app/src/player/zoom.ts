/** Multiplier layered over `positionPreview`'s contain-fit scale in `App.tsx`. */

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
export const ZOOM_FIT = 1
const ZOOM_STEP = 1.25

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

export function zoomIn(zoom: number): number {
  return clampZoom(zoom * ZOOM_STEP)
}

export function zoomOut(zoom: number): number {
  return clampZoom(zoom / ZOOM_STEP)
}

/** The readout's text while it is not being edited: a whole-number percent. */
export function zoomPercentText(zoom: number): string {
  return String(Math.round(zoom * 100))
}

/**
 * Parse the editable percent readout, the way the operator types into it.
 *
 * Digits only, matching the field's own `maxLength`/input filtering — no sign,
 * no decimal point, no percent character. Returns `null` for anything that is
 * not a usable value, and the caller must treat that as *do not commit this*
 * rather than as a value: an empty or half-typed field reverting to the last
 * good zoom is the only reading that does not silently teleport the preview.
 *
 * A parseable value is clamped rather than rejected — `999` becomes `ZOOM_MAX`
 * — because a percent outside the range is an operator overshoot, not a typo,
 * and clamping is what every other zoom entry point (`zoomIn`/`zoomOut`/the
 * +/− buttons) already does silently.
 */
export function parseZoomPercent(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const percent = Number(trimmed)
  if (!Number.isFinite(percent) || percent <= 0) return null
  return clampZoom(percent / 100)
}
