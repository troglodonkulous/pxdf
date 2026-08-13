import type { ShowFloor } from '../player/show';
import { floorGeometry } from '../render/geometry';

/** Validate the complete next value before any caller can start its IPC change. */
export function applyFloorSelection(
  current: ShowFloor,
  patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
): ShowFloor {
  const next: ShowFloor = { ...current, ...patch };
  floorGeometry(next.type, next.tileCols, next.tileRows);
  return next;
}
