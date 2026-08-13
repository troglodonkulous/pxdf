/**
 * One frame, from a decoder to wire bytes, with the failure path made explicit.
 *
 * ## Why this is a module and not four lines inside the render loop
 *
 * It used to be four lines inside the render loop, and that is how the taint
 * defect hid. `getImageData` threw `SecurityError` on every frame from the
 * moment the first cue went live, and because the throw happened *in the middle*
 * of the loop body, everything after it was skipped — the `writeFrame` that
 * feeds the floor, the preview paint, and the periodic `setStats`/`setSnapshot`
 * that are the only things telling React the engine moved. The engine was fine
 * throughout. The floor went black, the cue stack froze mid-change, the readout
 * sat at `0.00 ms one-pass`, and there was no error anywhere, because the one
 * place an error could have been recorded was downstream of the throw.
 *
 * The lesson is not "add a try/catch". It is that a show surface must have a
 * structural guarantee — the wire gets a frame every tick and the readout keeps
 * moving — rather than a guarantee that holds as long as nothing in the middle
 * misbehaves. Composition is the only step in that loop that touches a decoder,
 * a canvas and cross-origin media, so it is the step that gets a contract: it
 * returns bytes that are always safe to send, and it never throws.
 *
 * ## Why failure is attributed to the source
 *
 * `PlayerEngine` already knows what to do with a source that cannot play: name
 * it in `lastError` so the operator sees a banner, and take the floor to black
 * rather than hold a frame of something broken. It learns that through one
 * channel, `failed`, and `VideoSource.draw` already reports `drawImage`
 * failures that way. Reading the pixels back is the same failure with a
 * different exception, so it goes down the same channel — which also makes it
 * *converge*: the engine reaps the dead source, black comes from a decision
 * instead of an accident, and the loop stops raising the same exception sixty
 * times a second.
 */

import type { FloorGeometry } from '../render/geometry';
import { onePass, type PassOptions } from '../render/onePass';

/**
 * The part of a frame source composition needs.
 *
 * Deliberately narrower than `FrameSource`: this module has no business with
 * readiness or transport, and the narrower type is what lets the test drive it
 * with a few lines instead of a fake video element.
 */
export interface ComposeSource {
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  /** Terminal. See `VideoSource.fail`. */
  fail(): void;
}

export interface ComposeRequest {
  readonly source: ComposeSource;
  /** The work canvas, at `floor` resolution times the supersample factor. */
  readonly context: CanvasRenderingContext2D;
  readonly workWidth: number;
  readonly workHeight: number;
  readonly floor: FloorGeometry;
  readonly pass: PassOptions;
  /** Reused destination, to keep the pass off the allocation path. */
  readonly into: Uint8Array;
  /** What to send when the frame cannot be composed. Black, in this app. */
  readonly fallback: Uint8Array;
}

export interface Composed {
  /** Always safe to put on the wire. `fallback` when composition failed. */
  readonly bytes: Uint8Array;
  /**
   * How long the pass took, or `null` when there was no pass — which is what
   * keeps a failed frame out of the rolling average instead of recording it as
   * an implausibly fast one.
   */
  readonly passMs: number | null;
}

/**
 * Draw a source and pack it for the wire. Never throws.
 *
 * @returns the composed bytes, or `request.fallback` with `passMs: null` if any
 *          step failed — in which case `source.fail()` has been called.
 */
export function composeFrame(request: ComposeRequest): Composed {
  const { source, context, workWidth, workHeight, floor, pass, into, fallback } = request;

  try {
    source.draw(context, workWidth, workHeight);
    const pixels = context.getImageData(0, 0, workWidth, workHeight);
    const startedAt = performance.now();
    const bytes = onePass(pixels.data, floor, pass, into);
    return { bytes, passMs: performance.now() - startedAt };
  } catch {
    // The exception itself is not worth surfacing: it is the same one every
    // frame, and what the operator needs is the cue's name, which the engine
    // supplies once it reaps this source.
    source.fail();
    return { bytes: fallback, passMs: null };
  }
}
