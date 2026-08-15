/**
 * PR 1's gate: a gradient24 framebuffer through the one pass, out to
 * `mapper stream`, digested, and compared against the number that grades the
 * `play`/`send` cutover on hardware.
 *
 * This is the only test in the app that costs a subprocess, and it is the one
 * that makes the app's geometry layer answerable to `mapper/` rather than to
 * itself. Two things about how it is built matter more than the assertion:
 *
 *   - **The input comes from `mapper/patterns.py`, not from JavaScript.**
 *     `gradient24` is defined once in this repo. A second implementation of the
 *     pattern under test would be reliably self-consistent and occasionally
 *     wrong along with the thing it was grading — which is the failure mode
 *     `CLAUDE.md` opens with, six times over.
 *   - **The digest is computed by `mapper stream --dry-run`**, the same code
 *     path the app will drive in production, rather than by hashing bytes here.
 *
 * Neither half needs `mapper/` to change. If either digest below stops
 * matching, re-derive it from `mapper send` before touching any app code — the
 * expected values are copies, and a copy is exactly the kind of provenance
 * `CLAUDE.md` says to distrust.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { onePass, blackFrame } from '../src/render/onePass';
import { SHOP_RIG, JOB_RIG } from '../src/render/geometry';
import type { FloorGeometry, Rotation } from '../src/render/geometry';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = process.env.DDF_PYTHON ?? 'python3';

/** The gradient24 framebuffer for a floor, straight out of `mapper.patterns`. */
function gradient24(floor: FloorGeometry): Uint8ClampedArray {
  const script =
    'import sys;' +
    'from mapper.floors import FloorConfig;' +
    'from mapper.patterns import gradient24;' +
    `sys.stdout.buffer.write(bytes(gradient24(FloorConfig.of(${JSON.stringify(floor.type)},` +
    `${floor.tileCols},${floor.tileRows}))))`;
  const rgb = execFileSync(PYTHON, ['-c', script], {
    cwd: REPO_ROOT,
    maxBuffer: 1 << 26,
  });
  expect(rgb.length).toBe(floor.frameBytes);

  const rgba = new Uint8ClampedArray(floor.pixelCount * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    rgba[o] = rgb[i];
    rgba[o + 1] = rgb[i + 1];
    rgba[o + 2] = rgb[i + 2];
    rgba[o + 3] = 255;
  }
  return rgba;
}

/**
 * Push a framebuffer down the real sidecar protocol and read back the sha256 of
 * the datagrams it becomes. This is `mapper stream`'s documented byte contract:
 * raw back-to-back frames on stdin, no header, no length prefix, no delimiter.
 */
function wireDigest(floor: FloorGeometry, framebuffer: Uint8Array): string {
  const stdout = execFileSync(
    PYTHON,
    [
      '-m',
      'mapper',
      'stream',
      '--type',
      floor.type,
      '--cols',
      String(floor.tileCols),
      '--rows',
      String(floor.tileRows),
      '--dry-run',
    ],
    { cwd: REPO_ROOT, input: Buffer.from(framebuffer), encoding: 'utf8', maxBuffer: 1 << 26 },
  );

  const matches = [...stdout.matchAll(/^frame (\d+) sha256: ([0-9a-f]{64})$/gm)];
  expect(matches.length, `expected exactly one frame, got:\n${stdout}`).toBe(1);
  return matches[0][2];
}

const IDENTITY = { rotation: 0 as Rotation, mirrorX: false, mirrorY: false, s: 1, master: 1 };

const RIGS = [
  {
    name: 'shop · 10 x 5 · 80 x 40',
    floor: SHOP_RIG,
    // python -m mapper send --type 8x8_4P --cols 10 --rows 5 --pattern gradient24 --dry-run
    digest: '10cfd968b0b3436c6b50717f4c6cf69459b545b5c665c5d8003b268a561f8057',
  },
  {
    name: 'job · 10 x 12 · 80 x 96',
    floor: JOB_RIG,
    // python -m mapper send --type 8x8_4P --cols 10 --rows 12 --pattern gradient24 --dry-run
    digest: '12df0afcfb2c05be3b967822ae965dc251578b27f4813d372447c3d09d59352d',
  },
];

describe.each(RIGS)('the gradient24 gate — $name', ({ floor, digest }) => {
  it('matches the digest that grades the play/send cutover', () => {
    const src = gradient24(floor);
    const out = onePass(src, floor, IDENTITY);
    expect(wireDigest(floor, out)).toBe(digest);
  });

  it('is byte-identical to what mapper itself would have built', () => {
    // Cheaper and stricter than the digest, and it localises a failure: if this
    // passes and the digest above does not, the fault is in the seam, not in
    // the pass.
    const src = gradient24(floor);
    const out = onePass(src, floor, IDENTITY);
    for (let p = 0; p < floor.pixelCount; p++) {
      expect([out[p * 3], out[p * 3 + 1], out[p * 3 + 2]]).toEqual([
        src[p * 4],
        src[p * 4 + 1],
        src[p * 4 + 2],
      ]);
    }
  });

  // The mutations. At S = 1, rotation 0, no mirror and master 1 a correct pass
  // is a no-op, so the assertion above is also what a pass that ignored every
  // option would report. These are what make it grade something.
  it('FAILS the digest under a half turn', () => {
    const out = onePass(gradient24(floor), floor, { ...IDENTITY, rotation: 180 });
    expect(wireDigest(floor, out)).not.toBe(digest);
  });

  it('FAILS the digest under a mirror', () => {
    const out = onePass(gradient24(floor), floor, { ...IDENTITY, mirrorX: true });
    expect(wireDigest(floor, out)).not.toBe(digest);
  });

  it('FAILS the digest at master 0.99', () => {
    const out = onePass(gradient24(floor), floor, { ...IDENTITY, master: 0.99 });
    expect(wireDigest(floor, out)).not.toBe(digest);
  });

  it('FAILS the digest on a black frame', () => {
    expect(wireDigest(floor, blackFrame(floor))).not.toBe(digest);
  });
});

describe('the black frame', () => {
  // Not decoration. CLAUDE.md: stopping the send does not black the floor —
  // in Master/IR mode controller 1 reverts to vendor local content ~5 s later
  // while 2 and 3 hold their last frame; in slave mode controller 1 holds its
  // last frame too. Either way, BLACKOUT, cue gaps and idle must all *send*
  // black, and that frame has exactly one correct digest. PR 2's gate is
  // built on this.
  it('has a stable digest that both rigs agree on the shape of', () => {
    for (const { floor } of RIGS) {
      const viaMaster = onePass(gradient24(floor), floor, { ...IDENTITY, master: 0 });
      expect(Array.from(viaMaster)).toEqual(Array.from(blackFrame(floor)));
      expect(wireDigest(floor, blackFrame(floor))).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
