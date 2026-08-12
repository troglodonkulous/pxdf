/**
 * Floor geometry, derived the same way `mapper/floors.py` derives it.
 *
 * This module exists so that exactly one place in the app knows how many
 * pixels the floor is. PR 4 replaces its default with the Setup screen; until
 * then the shop rig is the default and the job rig is reachable by name, which
 * is what the digest gate needs in order to grade both.
 *
 * It deliberately does not model controllers, ports or packets. The app never
 * needs them — `mapper` owns the wire, and the only thing crossing the seam is
 * a framebuffer whose size is `pixelCount * 3`.
 */

/** Tile types, keyed as `mapper` names them on the command line. */
export const TILE_PX: Record<string, number> = {
  '8x8_4P': 8,
  '8x8_8P': 8,
  '6x6_4P': 6,
};

export type Rotation = 0 | 90 | 180 | 270;

export interface FloorGeometry {
  /** `--type` as `mapper` spells it. */
  readonly type: string;
  readonly tileCols: number;
  readonly tileRows: number;
  readonly tilePx: number;
  /** Physical floor pixels. Rotation does not change these. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixelCount: number;
  /** Bytes in one framebuffer on the sidecar's stdin. */
  readonly frameBytes: number;
}

export function floorGeometry(type: string, tileCols: number, tileRows: number): FloorGeometry {
  const tilePx = TILE_PX[type];
  if (tilePx === undefined) throw new Error(`unknown floor type: ${type}`);
  if (tileCols < 1 || tileRows < 1) throw new Error(`illegal tile counts: ${tileCols}x${tileRows}`);

  const widthPx = tileCols * tilePx;
  const heightPx = tileRows * tilePx;
  const pixelCount = widthPx * heightPx;
  return {
    type,
    tileCols,
    tileRows,
    tilePx,
    widthPx,
    heightPx,
    pixelCount,
    frameBytes: pixelCount * 3,
  };
}

/** 10 x 5 of `8x8_4P` = 80 x 40. Three controllers, ports 4/4/2. */
export const SHOP_RIG = floorGeometry('8x8_4P', 10, 5);

/**
 * 10 x 12 of `8x8_4P` = 80 x 96. Same three controllers, five packets per port
 * instead of two. Never seen on hardware — every number for it is derived from
 * `mapper plan`.
 */
export const JOB_RIG = floorGeometry('8x8_4P', 10, 12);

/**
 * The size of the canvas an operator authors on, which is the floor with
 * Rotation applied.
 *
 * Rotation is a *presentation* transform: a physically 80 x 96 portrait floor
 * can be authored as a 96 x 80 landscape canvas. It is not
 * `mapper/orientation.py`, which is cabling compensation applied at the
 * wire-mapping stage and is settled at `identity` permanently. The two must
 * never be merged — see CLAUDE.md.
 */
export function canvasSize(
  floor: FloorGeometry,
  rotation: Rotation,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: floor.heightPx, height: floor.widthPx }
    : { width: floor.widthPx, height: floor.heightPx };
}

/** The work canvas: the author canvas at S x linear supersampling. */
export function workSize(
  floor: FloorGeometry,
  rotation: Rotation,
  s: number,
): { width: number; height: number } {
  const c = canvasSize(floor, rotation);
  return { width: c.width * s, height: c.height * s };
}
