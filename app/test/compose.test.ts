/**
 * The frame-composition step, graded on the failure path it exists for.
 *
 * The defect this file was written against had no test that could see it, in
 * either direction. `engine.test.ts` grades the player's decisions over a fake
 * clock and never touches a canvas. `wire.mjs` drives the real app and *did*
 * catch the symptom — seven of twelve checks red — but it caught it as "GO puts
 * no frame on the wire", which is the last link in the chain, six steps from a
 * `getImageData` that was throwing `SecurityError` on every frame because the
 * media was cross-origin. Nothing in between said so.
 *
 * So the checks here are about the contract rather than the cause: a frame that
 * cannot be composed must come back as bytes that are still safe to send, must
 * not throw at the caller, and must tell the source it is dead so the engine
 * reaps it and the operator gets a name. Those hold for a tainted canvas, a
 * dead decoder and anything else that goes wrong in that step — which matters,
 * because the next cause will not be a tainted canvas.
 *
 * Two of them would be vacuous on their own: "returns black" is what a function
 * that ignored its input entirely would also do. They are paired with the happy
 * path, which must return composed bytes and a real pass time, so that a
 * `composeFrame` stuck in either mode fails one of the pair.
 */

import { describe, it, expect, vi } from 'vitest';
import { composeFrame, type ComposeSource } from '../src/player/compose';
import { SHOP_RIG, workSize } from '../src/render/geometry';
import { blackFrame } from '../src/render/onePass';

const S = 1;
const WORK = workSize(SHOP_RIG, 0, S);
const PASS = { rotation: 0 as const, mirrorX: false, mirrorY: false, s: S, master: 1 };
const BLACK = blackFrame(SHOP_RIG);

/** A work canvas that hands back a solid colour, or refuses to be read. */
function fakeContext(options: { readonly readable: boolean; readonly value?: number }) {
  return {
    getImageData: (): ImageData => {
      if (!options.readable) {
        throw new DOMException(
          'The canvas has been tainted by cross-origin data.',
          'SecurityError',
        );
      }
      const data = new Uint8ClampedArray(WORK.width * WORK.height * 4);
      data.fill(options.value ?? 0);
      // Alpha is irrelevant to the pass but a real ImageData always has it.
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      return { data } as ImageData;
    },
  } as unknown as CanvasRenderingContext2D;
}

function fakeSource(options: { readonly drawThrows?: boolean } = {}) {
  return {
    draw: (): void => {
      if (options.drawThrows === true) throw new Error('decoder is gone');
    },
    fail: vi.fn<() => void>(),
  } satisfies ComposeSource;
}

function request(source: ComposeSource, context: CanvasRenderingContext2D) {
  return {
    source,
    context,
    workWidth: WORK.width,
    workHeight: WORK.height,
    floor: SHOP_RIG,
    pass: PASS,
    into: new Uint8Array(SHOP_RIG.frameBytes),
    fallback: BLACK,
  };
}

describe('composeFrame', () => {
  it('packs a readable frame and reports how long the pass took', () => {
    const source = fakeSource();
    const composed = composeFrame(request(source, fakeContext({ readable: true, value: 255 })));

    expect(composed.bytes).toHaveLength(SHOP_RIG.frameBytes);
    expect([...composed.bytes.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    expect(composed.passMs).not.toBeNull();
    expect(source.fail).not.toHaveBeenCalled();
  });

  it('returns the fallback frame instead of throwing when the canvas cannot be read', () => {
    const source = fakeSource();

    // The whole defect in one line: this call used to propagate, and everything
    // downstream of it in the render loop — the write to the wire, the preview,
    // the stats React renders from — was skipped for every frame after the
    // first cue went live.
    const composed = composeFrame(request(source, fakeContext({ readable: false })));

    expect(composed.bytes).toBe(BLACK);
    expect(composed.passMs).toBeNull();
  });

  it('marks the source failed so the engine reaps it and names it to the operator', () => {
    const source = fakeSource();
    composeFrame(request(source, fakeContext({ readable: false })));
    expect(source.fail).toHaveBeenCalledOnce();
  });

  it('treats a decoder that throws on draw the same way', () => {
    const source = fakeSource({ drawThrows: true });
    const composed = composeFrame(request(source, fakeContext({ readable: true })));

    expect(composed.bytes).toBe(BLACK);
    expect(composed.passMs).toBeNull();
    expect(source.fail).toHaveBeenCalledOnce();
  });
});
