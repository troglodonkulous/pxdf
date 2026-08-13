/**
 * Floor geometry, derived the same way `mapper/floors.py` derives it.
 *
 * This module exists so that exactly one place in the app knows how many
 * pixels the floor is. PR 3 replaces its default with the Mapping surface; until
 * then the shop rig is the default and the job rig is reachable by name, which
 * is what the digest gate needs in order to grade both.
 *
 * It deliberately does not model controllers, ports or packets. The app never
 * needs them — `mapper` owns the wire, and the only thing crossing the seam is
 * a framebuffer whose size is `pixelCount * 3`.
 */

/**
 * The tile types `mapper` accepts, with the limits it enforces on each.
 *
 * `maxTileRows` is not decoration and not a UI nicety. `main.ts`'s
 * `doSetFloor` stops the running sidecar and spawns a replacement, and it
 * validates through `floorGeometry` *first* precisely so an impossible
 * selection rejects while the old sender is still alive. That guard is only as
 * strong as this table: a row count this file waves through and
 * `mapper/floors.py` refuses means the old sidecar is stopped, `mapper stream`
 * exits on startup, and the floor has no sender at all — controller 1 reverts
 * to the vendor's own content about five seconds later, mid-show.
 *
 * The limits are per type because the packet budget is: an 8-port type spends
 * its ports twice as fast down a chain, so `8x8_8P` tops out at 11 rows where
 * `6x6_4P` reaches 25. `mapping.test.ts` reads `FLOOR_TYPES` and
 * `MAX_TILE_COLS` out of `mapper/floors.py` and asserts these match, so this
 * is a copy that cannot drift silently — which is the only kind worth having.
 */
export interface FloorTypeLimits {
  readonly tilePx: number;
  readonly maxTileRows: number;
}

export const TILE_PX: Record<string, FloorTypeLimits> = {
  '8x8_4P': { tilePx: 8, maxTileRows: 22 },
  '8x8_8P': { tilePx: 8, maxTileRows: 11 },
  '6x6_4P': { tilePx: 6, maxTileRows: 25 },
  '6x6_8P': { tilePx: 6, maxTileRows: 17 },
};

/** `mapper/floors.py`'s `MAX_TILE_COLS`, the same for every type. */
export const MAX_TILE_COLS = 32;

/** How many tile rows this type may have. Throws on a type `mapper` has not. */
export function maxTileRows(type: string): number {
  const limits = TILE_PX[type];
  if (limits === undefined) throw new Error(`unknown floor type: ${type}`);
  return limits.maxTileRows;
}

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
  const limits = TILE_PX[type];
  if (limits === undefined) throw new Error(`unknown floor type: ${type}`);
  const tilePx = limits.tilePx;
  if (!Number.isInteger(tileCols) || tileCols < 1 || tileCols > MAX_TILE_COLS) {
    throw new Error(`tile columns ${tileCols} outside 1..${MAX_TILE_COLS}`);
  }
  if (!Number.isInteger(tileRows) || tileRows < 1 || tileRows > limits.maxTileRows) {
    throw new Error(`tile rows ${tileRows} outside 1..${limits.maxTileRows} for ${type}`);
  }

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
