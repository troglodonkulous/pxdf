/**
 * THE ONE PASS — the app's whole geometry layer, in one loop.
 *
 * Rotation, mirror, master brightness, the box downsample and the RGBA-to-RGB
 * repack are the same traversal of the framebuffer. That is the architectural
 * centre of `docs/APP-PLAN.md`: doing any one of them separately means reading
 * every pixel twice, and at the job rig's 640 x 768 work canvas a second
 * traversal is ~492k reads per frame that buy nothing.
 *
 * It is a pure function over typed arrays rather than a method on a canvas, for
 * three reasons that are all about being gradeable:
 *
 *   - `S = 1` is then an ordinary argument, not a test-only backdoor. The gate
 *     needs S = 1 to be byte-comparable against `mapper send`; the operator only
 *     ever sees 4 / 8 / 16.
 *   - The gate runs under a plain unit-test runner with no canvas, no
 *     `putImageData` and no headless Electron, which makes it cheap enough to
 *     run on every change rather than once at review.
 *   - When S = 16 wins at the shop and this moves to a WebGL shader, the thing
 *     being replaced has an exact specification and an exact test.
 *
 * The output is what `mapper stream` reads off stdin: `pixelCount * 3` bytes,
 * row-major RGB, top-left origin, no header and no delimiter.
 */

import type { FloorGeometry, Rotation } from './geometry';
import { canvasSize } from './geometry';

export interface PassOptions {
  /**
   * Presentation rotation, clockwise, applied to the authored canvas to produce
   * the floor. NOT `mapper/orientation.py`, which is cabling compensation and is
   * settled at `identity` permanently. See CLAUDE.md.
   */
  rotation: Rotation;
  /** Mirror in author space, before rotation. */
  mirrorX: boolean;
  mirrorY: boolean;
  /** Linear supersample factor. 4 / 8 / 16 ship; 1 is the gate's. */
  s: number;
  /** Master brightness, 0..1. */
  master: number;
}

/**
 * @param src   Work-canvas pixels, RGBA, as `ctx.getImageData(...).data` gives
 *              them. Must be `canvasWidth * s` by `canvasHeight * s`.
 * @param out   Optional destination, reused across frames to keep this off the
 *              allocation path. Must be exactly `floor.frameBytes` long.
 */
export function onePass(
  src: Uint8ClampedArray,
  floor: FloorGeometry,
  opts: PassOptions,
  out?: Uint8Array,
): Uint8Array {
  const { rotation, mirrorX, mirrorY, s, master } = opts;

  if (!Number.isInteger(s) || s < 1) throw new Error(`illegal supersample factor: ${s}`);
  if (!(master >= 0 && master <= 1)) throw new Error(`master out of range: ${master}`);

  const { width: canvasW, height: canvasH } = canvasSize(floor, rotation);
  const workW = canvasW * s;
  const workH = canvasH * s;
  const expected = workW * workH * 4;
  if (src.length !== expected) {
    throw new Error(`src is ${src.length} bytes, expected ${expected} (${workW}x${workH} RGBA)`);
  }

  const floorW = floor.widthPx;
  const floorH = floor.heightPx;
  const dst = out ?? new Uint8Array(floor.frameBytes);
  if (dst.length !== floor.frameBytes) {
    throw new Error(`out is ${dst.length} bytes, expected ${floor.frameBytes}`);
  }

  const samples = s * s;
  // Rounding is `Math.round` on a non-negative value, i.e. half away from zero,
  // and it is part of the contract rather than an implementation detail: at
  // S = 1 with master = 1 both the average and the scale are exact, so the pass
  // is a byte-for-byte identity and the digest gate means something. Any other
  // rounding here changes frames the gate cannot see.
  let o = 0;

  for (let fy = 0; fy < floorH; fy++) {
    for (let fx = 0; fx < floorW; fx++) {
      // Floor coordinates back to author-canvas coordinates: undo the rotation,
      // then undo the mirror. Both are involutions on their own axis, so the
      // inverse of "mirror, then rotate" is "unrotate, then unmirror".
      let cx: number;
      let cy: number;
      switch (rotation) {
        case 0:
          cx = fx;
          cy = fy;
          break;
        case 90:
          cx = fy;
          cy = canvasH - 1 - fx;
          break;
        case 180:
          cx = canvasW - 1 - fx;
          cy = canvasH - 1 - fy;
          break;
        case 270:
          cx = canvasW - 1 - fy;
          cy = fx;
          break;
        default:
          throw new Error(`illegal rotation: ${rotation as number}`);
      }
      if (mirrorX) cx = canvasW - 1 - cx;
      if (mirrorY) cy = canvasH - 1 - cy;

      // The S x S block of work pixels this floor pixel averages. Orientation
      // inside the block is irrelevant — a mean does not care what order its
      // terms arrive in — which is why rotation and mirror can be resolved at
      // block granularity and the downsample stays a flat sum.
      let r = 0;
      let g = 0;
      let b = 0;
      const x0 = cx * s;
      const y1 = (cy + 1) * s;
      for (let wy = cy * s; wy < y1; wy++) {
        let i = (wy * workW + x0) * 4;
        for (let k = 0; k < s; k++) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          // Alpha is dropped, not composited. The work canvas is cleared to
          // opaque black every frame, so alpha is 255 by construction and a
          // layer that lowers it has already composited against black — which
          // is what an LED floor physically does with a dark pixel.
          i += 4;
        }
      }

      const scale = master / samples;
      dst[o] = Math.round(r * scale);
      dst[o + 1] = Math.round(g * scale);
      dst[o + 2] = Math.round(b * scale);
      o += 3;
    }
  }

  return dst;
}

/** An all-black framebuffer for this floor: BLACKOUT, idle, and cue gaps. */
export function blackFrame(floor: FloorGeometry): Uint8Array {
  return new Uint8Array(floor.frameBytes);
}
