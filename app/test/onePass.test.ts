/**
 * The one pass, graded on its own algebra — no canvas, no Electron, no Python.
 *
 * `docs/APP-PLAN.md` names three gates for PR 1: the gradient24 digest, rotate
 * x4 -> identity, and mirror x2 -> identity. The digest lives in
 * `gate.digest.test.ts` because it needs `mapper/`; the two identities live
 * here, along with the checks that stop them from being vacuous.
 *
 * The vacuity problem is real and specific. At S = 1, rotation 0, no mirror and
 * master 1 a correct pass is a no-op, so "the digest matched" is also what a
 * pass that silently ignored every option would report. Each identity below is
 * therefore paired with a mutation that must *fail*, and the box filter — which
 * S = 1 never exercises at all — is checked against a hand-computed average.
 */

import { describe, it, expect } from 'vitest';
import { onePass, blackFrame } from '../src/render/onePass';
import { floorGeometry, canvasSize, workSize, SHOP_RIG, JOB_RIG } from '../src/render/geometry';
import type { Rotation } from '../src/render/geometry';

/** Repack an RGB framebuffer back into RGBA so it can be fed in again. */
function toRgba(rgb: Uint8Array): Uint8ClampedArray {
  const px = rgb.length / 3;
  const out = new Uint8ClampedArray(px * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    out[o] = rgb[i];
    out[o + 1] = rgb[i + 1];
    out[o + 2] = rgb[i + 2];
    out[o + 3] = 255;
  }
  return out;
}

/**
 * A per-pixel-unique RGBA test image, in the spirit of `mapper/patterns.py`:
 * a solid colour cannot detect a permutation, because every wrong mapping of a
 * white frame is still a white frame.
 */
function uniqueImage(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[i] = (x * 7 + y * 13 + 1) & 0xff;
      out[i + 1] = y & 0xff;
      out[i + 2] = x & 0xff;
      out[i + 3] = 255;
      i += 4;
    }
  }
  return out;
}

const IDENTITY = { rotation: 0 as Rotation, mirrorX: false, mirrorY: false, s: 1, master: 1 };

describe('geometry', () => {
  it('derives the two rigs the way mapper does', () => {
    expect([SHOP_RIG.widthPx, SHOP_RIG.heightPx]).toEqual([80, 40]);
    expect(SHOP_RIG.frameBytes).toBe(9600);
    expect([JOB_RIG.widthPx, JOB_RIG.heightPx]).toEqual([80, 96]);
    expect(JOB_RIG.frameBytes).toBe(23040);
  });

  it('swaps the author canvas on the quarter turns and not on the half turn', () => {
    expect(canvasSize(JOB_RIG, 0)).toEqual({ width: 80, height: 96 });
    expect(canvasSize(JOB_RIG, 90)).toEqual({ width: 96, height: 80 });
    expect(canvasSize(JOB_RIG, 180)).toEqual({ width: 80, height: 96 });
    expect(canvasSize(JOB_RIG, 270)).toEqual({ width: 96, height: 80 });
  });

  it('scales the work canvas by S in both axes', () => {
    expect(workSize(JOB_RIG, 0, 8)).toEqual({ width: 640, height: 768 });
  });
});

describe('the pass at S = 1 is an exact identity', () => {
  it('returns its input unchanged, byte for byte', () => {
    const src = uniqueImage(SHOP_RIG.widthPx, SHOP_RIG.heightPx);
    const out = onePass(src, SHOP_RIG, IDENTITY);

    expect(out.length).toBe(SHOP_RIG.frameBytes);
    for (let p = 0; p < SHOP_RIG.pixelCount; p++) {
      expect([out[p * 3], out[p * 3 + 1], out[p * 3 + 2]]).toEqual([
        src[p * 4],
        src[p * 4 + 1],
        src[p * 4 + 2],
      ]);
    }
  });

  it('drops alpha rather than compositing it', () => {
    const src = uniqueImage(8, 8);
    const floor = floorGeometry('8x8_4P', 1, 1);
    const opaque = onePass(src, floor, IDENTITY);
    for (let i = 3; i < src.length; i += 4) src[i] = 0;
    const transparent = onePass(src, floor, IDENTITY);
    expect(Array.from(transparent)).toEqual(Array.from(opaque));
  });
});

describe('rotate x4 -> identity', () => {
  // A quarter turn swaps the floor's axes, so four turns walk 80x40 -> 40x80
  // -> 80x40 -> 40x80 -> 80x40. The geometry alternates with it; feeding one
  // floor's output back into the same floor would be testing a different claim.
  const landscape = SHOP_RIG; // 80 x 40
  const portrait = floorGeometry('8x8_4P', 5, 10); // 40 x 80

  it('comes back to the original image', () => {
    const original = uniqueImage(landscape.widthPx, landscape.heightPx);
    let frame = original;
    for (const floor of [portrait, landscape, portrait, landscape]) {
      frame = toRgba(onePass(frame, floor, { ...IDENTITY, rotation: 90 }));
    }
    expect(Array.from(frame)).toEqual(Array.from(original));
  });

  it('does NOT come back after one turn, two turns or three', () => {
    // Without this the test above passes for a pass that ignores `rotation`.
    const original = uniqueImage(landscape.widthPx, landscape.heightPx);
    let frame = original;
    const floors = [portrait, landscape, portrait];
    for (const floor of floors) {
      frame = toRgba(onePass(frame, floor, { ...IDENTITY, rotation: 90 }));
      if (frame.length === original.length) {
        expect(Array.from(frame)).not.toEqual(Array.from(original));
      }
    }
  });

  it('agrees with 180 when applied twice', () => {
    const original = uniqueImage(landscape.widthPx, landscape.heightPx);
    const twice = toRgba(
      onePass(
        toRgba(onePass(original, portrait, { ...IDENTITY, rotation: 90 })),
        landscape,
        { ...IDENTITY, rotation: 90 },
      ),
    );
    const half = onePass(original, landscape, { ...IDENTITY, rotation: 180 });
    expect(Array.from(twice)).toEqual(Array.from(toRgba(half)));
  });

  it('90 and 270 are inverses', () => {
    const original = uniqueImage(landscape.widthPx, landscape.heightPx);
    const there = toRgba(onePass(original, portrait, { ...IDENTITY, rotation: 90 }));
    const back = onePass(there, landscape, { ...IDENTITY, rotation: 270 });
    expect(Array.from(toRgba(back))).toEqual(Array.from(original));
  });
});

describe('mirror x2 -> identity', () => {
  const floor = SHOP_RIG;
  const original = uniqueImage(floor.widthPx, floor.heightPx);

  for (const axis of ['mirrorX', 'mirrorY'] as const) {
    it(`${axis} twice is the original`, () => {
      const once = onePass(original, floor, { ...IDENTITY, [axis]: true });
      const twice = onePass(toRgba(once), floor, { ...IDENTITY, [axis]: true });
      expect(Array.from(twice)).toEqual(Array.from(onePass(original, floor, IDENTITY)));
    });

    it(`${axis} once is NOT the original`, () => {
      const once = onePass(original, floor, { ...IDENTITY, [axis]: true });
      const plain = onePass(original, floor, IDENTITY);
      expect(Array.from(once)).not.toEqual(Array.from(plain));
    });
  }

  it('both axes together equal a 180 rotation', () => {
    const both = onePass(original, floor, { ...IDENTITY, mirrorX: true, mirrorY: true });
    const half = onePass(original, floor, { ...IDENTITY, rotation: 180 });
    expect(Array.from(both)).toEqual(Array.from(half));
  });

  it('mirrors in author space, so mirrorX under a quarter turn moves rows', () => {
    // The ordering is load-bearing: mirror-then-rotate and rotate-then-mirror
    // differ on the quarter turns, and only the first lets an operator reason
    // about the canvas they authored.
    const portrait = floorGeometry('8x8_4P', 5, 10);
    const mirroredFirst = onePass(original, portrait, {
      ...IDENTITY,
      rotation: 90,
      mirrorX: true,
    });
    const plain = onePass(original, portrait, { ...IDENTITY, rotation: 90 });
    expect(Array.from(mirroredFirst)).not.toEqual(Array.from(plain));

    // Derived rather than asserted from a second implementation. The author
    // canvas here is 80 x 40 and the floor is 40 x 80, so with canvasH = 40:
    //
    //   plain          floor(fx, fy) = canvas(fy,      39 - fx)
    //   mirrorX first  floor(fx, fy) = canvas(79 - fy, 39 - fx)
    //
    // and substituting fy -> 79 - fy into the first gives the second. So a
    // horizontal flip of the author canvas lands as a *vertical* flip of the
    // floor under a quarter turn — the whole reason the order is fixed as
    // mirror-then-rotate, since it is the author's canvas the operator can
    // reason about, not the floor's.
    const w = portrait.widthPx;
    const h = portrait.heightPx;
    for (let fy = 0; fy < h; fy++) {
      for (let fx = 0; fx < w; fx++) {
        const here = (fy * w + fx) * 3;
        const flipped = ((h - 1 - fy) * w + fx) * 3;
        expect(mirroredFirst[here]).toBe(plain[flipped]);
      }
    }
  });
});

describe('the box downsample', () => {
  // S = 1 never exercises this. Two averages, computed by hand.
  const floor = floorGeometry('8x8_4P', 1, 1); // 8 x 8

  function workCanvas(s: number): Uint8ClampedArray {
    const { width, height } = workSize(floor, 0, s);
    const buf = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    return buf;
  }

  it('averages a 2 x 2 block and rounds half away from zero', () => {
    const s = 2;
    const { width } = workSize(floor, 0, s);
    const src = workCanvas(s);
    // Block (0, 0) reds: 0, 1, 2, 3. Mean 6/4 = 1.5 -> 2.
    src[0 * 4] = 0;
    src[1 * 4] = 1;
    src[(width + 0) * 4] = 2;
    src[(width + 1) * 4] = 3;
    // Block (1, 0) reds: 0, 1, 1, 1. Mean 3/4 = 0.75 -> 1.
    src[2 * 4] = 0;
    src[3 * 4] = 1;
    src[(width + 2) * 4] = 1;
    src[(width + 3) * 4] = 1;

    const out = onePass(src, floor, { ...IDENTITY, s });
    expect(out[0]).toBe(2);
    expect(out[3]).toBe(1);
  });

  it('a uniform block survives the downsample exactly', () => {
    const s = 4;
    const src = workCanvas(s);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 200;
      src[i + 1] = 100;
      src[i + 2] = 50;
    }
    const out = onePass(src, floor, { ...IDENTITY, s });
    expect(Array.from(out.slice(0, 6))).toEqual([200, 100, 50, 200, 100, 50]);
  });

  it('rejects a work canvas that is not the floor times S', () => {
    expect(() => onePass(workCanvas(2), floor, { ...IDENTITY, s: 4 })).toThrow(/expected/);
  });
});

describe('master', () => {
  const floor = floorGeometry('8x8_4P', 1, 1);
  const src = uniqueImage(8, 8);

  it('at 1 changes nothing', () => {
    expect(Array.from(onePass(src, floor, IDENTITY))).toEqual(
      Array.from(onePass(src, floor, { ...IDENTITY, master: 1 })),
    );
  });

  it('at 0 is a black frame — which is what BLACKOUT must put on the wire', () => {
    expect(Array.from(onePass(src, floor, { ...IDENTITY, master: 0 }))).toEqual(
      Array.from(blackFrame(floor)),
    );
  });

  it('at 0.99 is NOT the same frame', () => {
    // The mutation that catches a pass ignoring `master` altogether.
    expect(Array.from(onePass(src, floor, { ...IDENTITY, master: 0.99 }))).not.toEqual(
      Array.from(onePass(src, floor, IDENTITY)),
    );
  });

  it('is rejected outside 0..1', () => {
    expect(() => onePass(src, floor, { ...IDENTITY, master: 1.5 })).toThrow(/master/);
    expect(() => onePass(src, floor, { ...IDENTITY, master: -0.1 })).toThrow(/master/);
  });
});

describe('the output buffer', () => {
  it('is reused when one is handed in', () => {
    const floor = floorGeometry('8x8_4P', 1, 1);
    const out = new Uint8Array(floor.frameBytes);
    expect(onePass(uniqueImage(8, 8), floor, IDENTITY, out)).toBe(out);
  });

  it('is rejected at the wrong size', () => {
    const floor = floorGeometry('8x8_4P', 1, 1);
    expect(() => onePass(uniqueImage(8, 8), floor, IDENTITY, new Uint8Array(7))).toThrow(/out is/);
  });
});
