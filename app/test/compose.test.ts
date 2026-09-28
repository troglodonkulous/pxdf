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

/**
 * The three spans, and why they had to be three.
 *
 * The timer used to start *after* `getImageData`, so `passMs` was the pack step
 * alone and everything before it — the decoder handing over a frame, and a
 * full-canvas readback that at S = 8 copies about 1.6 MB — was charged to
 * nothing at all. The readout said `0.00 ms one-pass` and was telling the truth
 * about a third of the work. That is not a wrong number, which is the problem:
 * it is a right number for a question nobody was asking, standing where the
 * answer to the question they were asking should have been.
 *
 * The contract these grade is the one the render loop and the heartbeat both
 * depend on: three fields that are all real or all null, never a mixture, so a
 * caller needs one guard rather than three and an average can never be made of
 * a frame that half happened.
 */
describe('composeFrame timings', () => {
  it('reports draw, readback and pass separately on a good frame', () => {
    const composed = composeFrame(request(fakeSource(), fakeContext({ readable: true, value: 255 })));

    expect(composed.drawMs).not.toBeNull();
    expect(composed.readbackMs).not.toBeNull();
    expect(composed.passMs).not.toBeNull();
    for (const span of [composed.drawMs, composed.readbackMs, composed.passMs]) {
      expect(span).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(span)).toBe(true);
    }
  });

  it('charges the readback to the readback, not to the pass', () => {
    // The regression this whole split exists for. A context whose
    // `getImageData` takes measurable time must move `readbackMs` and must not
    // move `passMs`; before the split it moved neither, because the clock had
    // not started yet.
    const SLOW_MS = 12;
    const base = fakeContext({ readable: true, value: 255 });
    const slow = {
      getImageData: (...args: unknown[]): ImageData => {
        const until = performance.now() + SLOW_MS;
        while (performance.now() < until) { /* burn, so the span is real time */ }
        return (base.getImageData as unknown as (...a: unknown[]) => ImageData)(...args);
      },
    } as unknown as CanvasRenderingContext2D;

    const composed = composeFrame(request(fakeSource(), slow));
    expect(composed.readbackMs).toBeGreaterThanOrEqual(SLOW_MS);
    // Paired with its own disproof: an implementation that simply reported the
    // whole function's duration in every field would satisfy the line above.
    expect(composed.passMs).toBeLessThan(SLOW_MS);
    expect(composed.drawMs).toBeLessThan(SLOW_MS);
  });

  it('charges a slow decoder to the draw', () => {
    const SLOW_MS = 12;
    const source = {
      draw: (): void => {
        const until = performance.now() + SLOW_MS;
        while (performance.now() < until) { /* burn */ }
      },
      fail: vi.fn<() => void>(),
    } satisfies ComposeSource;

    const composed = composeFrame(request(source, fakeContext({ readable: true, value: 255 })));
    expect(composed.drawMs).toBeGreaterThanOrEqual(SLOW_MS);
    expect(composed.readbackMs).toBeLessThan(SLOW_MS);
    expect(composed.passMs).toBeLessThan(SLOW_MS);
  });

  it('nulls all three when the readback fails, including the draw that succeeded', () => {
    // `draw` really did complete and really was measured, and the number is
    // still discarded. Averaging the timings of frames that never reached the
    // wire into the statistic describing the frames that did is how a readout
    // gets quietly faster the worse the show goes.
    const composed = composeFrame(request(fakeSource(), fakeContext({ readable: false })));
    expect(composed.drawMs).toBeNull();
    expect(composed.readbackMs).toBeNull();
    expect(composed.passMs).toBeNull();
  });

  it('nulls all three when the draw fails', () => {
    const composed = composeFrame(request(fakeSource({ drawThrows: true }), fakeContext({ readable: true })));
    expect(composed.drawMs).toBeNull();
    expect(composed.readbackMs).toBeNull();
    expect(composed.passMs).toBeNull();
  });
});
