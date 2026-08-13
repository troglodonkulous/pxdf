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
