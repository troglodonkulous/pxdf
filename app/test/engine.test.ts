/**
 * PR 2's gate, asserted where it can actually be seen.
 *
 * The gate is "black frames on the wire for BLACKOUT, cue gaps and idle ·
 * gapless cue change · the socket never closes". Two of those three cannot be
 * graded from a UDP capture, and believing otherwise is the trap this file is
 * built around:
 *
 *   - `Sidecar` re-sends its last frame forever when the renderer stalls, so a
 *     capture of a *frozen* cue change and a capture of a *perfect* one are the
 *     same bytes. The wire cannot tell them apart. Gaplessness is therefore
 *     asserted on the engine's per-frame decision, which is the thing that
 *     actually differs.
 *   - "The socket never closes" is a property of `Sidecar` and `main.ts`, both
 *     already graded in `sidecar.test.ts`. What belongs here is the half the
 *     engine owns: that it always yields a wire decision, so the caller always
 *     has something to write and never simply stops writing.
 *
 * The black-frame invariant is the one that is exact on the wire, and PR 1's
 * shutdown capture already grades it there. Here it is graded as a decision:
 * idle, BLACKOUT and the end of a stack all resolve to `kind: 'black'`.
 */

import { describe, it, expect } from 'vitest';
import { PlayerEngine, type FrameSource, type Target } from '../src/player/engine';
import type { Cue, Show } from '../src/player/show';
import { SHOW_FILE_VERSION } from '../src/player/show';

/**
 * A source with every state transition under the test's control.
 *
 * `ready` is a field rather than a promise on purpose: the engine's contract is
 * that it re-reads readiness on every tick, and a promise would let a test pass
 * by resolving between ticks in a way a real decoder never does.
 */
class FakeSource implements FrameSource {
  ready = false;
  failed = false;
  positionMs = 0;
  mediaDurationMs: number | null = null;
  playCalls = 0;
  pauseCalls = 0;
  disposed = false;
  /** Set to make teardown throw, as a real element's can. */
  disposeThrows = false;

  constructor(readonly cueId: string) {}

  play(): void {
    this.playCalls += 1;
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  dispose(): void {
    this.disposed = true;
    if (this.disposeThrows) throw new Error(`teardown of ${this.cueId} failed`);
  }
}

function cue(id: string, durationMs: number | null = null): Cue {
  return { id, name: `Cue ${id}`, source: { kind: 'video', path: `/media/${id}.mp4` }, durationMs };
}

function show(...cues: Cue[]): Show {
  return {
    version: SHOW_FILE_VERSION,
    name: 'test show',
    floor: { type: '8x8_4P', tileCols: 10, tileRows: 5 },
    cues,
  };
}

/** An engine over fake sources, with a clock the test advances by hand. */
function build(s: Show) {
  const sources = new Map<string, FakeSource>();
  /**
   * How many decoders the engine has built per cue.
   *
   * This counter exists because the obvious assertion — `source('b').playCalls`
   * — cannot fail. An engine that re-arms a cue every tick builds a *new*
   * source each time, so the map holds only the last one and its `playCalls` is
   * 1 however many were created. Counting creations is the only thing that
   * distinguishes one decoder from thirty of them.
   */
  const created = new Map<string, number>();
  let clock = 0;

  const engine = new PlayerEngine<FakeSource>({
    show: s,
    now: () => clock,
    createSource: (c) => {
      const source = new FakeSource(c.id);
      sources.set(c.id, source);
      created.set(c.id, (created.get(c.id) ?? 0) + 1);
      return source;
    },
  });

  return {
    engine,
    sources,
    created: (id: string): number => created.get(id) ?? 0,
    source: (id: string): FakeSource => {
      const found = sources.get(id);
      if (found === undefined) throw new Error(`no source was created for ${id}`);
      return found;
    },
    advance: (ms: number): void => {
      clock += ms;
    },
    /** Tick n times and return every wire decision, in order. */
    run: (n = 1): Target<FakeSource>[] => {
      const wire: Target<FakeSource>[] = [];
      for (let i = 0; i < n; i++) wire.push(engine.tick().wire);
      return wire;
    },
  };
}

/** The cue id behind a wire decision, or null for black. */
function onWire(target: Target<FakeSource>): string | null {
  return target.kind === 'source' ? target.source.cueId : null;
}

describe('black is a frame, not silence', () => {
  it('puts black on the wire when nothing is live', () => {
    const rig = build(show(cue('a')));
    expect(rig.run(3).map(onWire)).toEqual([null, null, null]);
  });

  it('puts black on the wire under BLACKOUT even with a cue live', () => {
    const rig = build(show(cue('a')));
    rig.engine.go();
    rig.source('a').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('a');

    rig.engine.setBlackout(true);
    expect(rig.run(3).map(onWire)).toEqual([null, null, null]);

    // And BLACKOUT is a wire decision, not a teardown: releasing it restores
    // the same source rather than restarting the cue.
    rig.engine.setBlackout(false);
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.source('a').disposed).toBe(false);
  });

  it('returns a wire decision on every tick, so the caller never stops writing', () => {
    const rig = build(show(cue('a', 100), cue('b')));
    rig.engine.go();
    rig.source('a').ready = true;

    for (let i = 0; i < 40; i++) {
      rig.advance(10);
      const tick = rig.engine.tick();
      expect(tick.wire).toBeDefined();
      expect(tick.wire.kind === 'black' || tick.wire.kind === 'source').toBe(true);
    }
  });

  it('goes black at the end of the stack rather than holding the last cue', () => {
    const rig = build(show(cue('a', 100)));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.advance(150);
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.source('a').disposed).toBe(true);
  });
});

describe('a cue change never shows black', () => {
  it('holds the outgoing cue on the wire until the incoming one has decoded', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    // Twenty frames of the incoming decoder not being ready — two thirds of a
    // second at 30 fps, an entirely ordinary seek-and-decode on a cold file.
    const during = rig.run(20).map(onWire);
    expect(during).toEqual(Array(20).fill('a'));
    expect(during).not.toContain(null);

    rig.source('b').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('b');
  });

  it('disposes the outgoing source only after the incoming one is on the wire', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.run(5);
    expect(rig.source('a').disposed).toBe(false);

    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.source('a').disposed).toBe(true);
    expect(rig.source('b').disposed).toBe(false);
  });

  it('starts the incoming decoder at GO, not at the flip', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('b');
    // Arming is what makes the change gapless. A source that only starts
    // decoding once it is wanted on the wire is guaranteed to gap.
    expect(rig.source('b').playCalls).toBe(1);
    expect(onWire(rig.engine.tick().wire)).toBe(null);
  });

  it('overruns a finite duration rather than gapping when the next cue is slow', () => {
    const rig = build(show(cue('a', 100), cue('b')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.advance(500);
    const during = rig.run(10).map(onWire);
    expect(during).toEqual(Array(10).fill('a'));

    rig.source('b').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('b');
  });

  it('does not re-arm the incoming cue on every tick while it is decoding', () => {
    const rig = build(show(cue('a', 100), cue('b')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.advance(500);
    rig.run(30);
    // Re-arming per frame would build a new decoder 30 times over and
    // guarantee the gap the arming exists to prevent. Count creations, not
    // `playCalls` on the handle — see `created` above for why.
    expect(rig.created('b')).toBe(1);
    expect(rig.source('b').playCalls).toBe(1);
  });

  it('completes the change when the outgoing decoder throws on teardown', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').ready = true;
    rig.source('a').disposeThrows = true;

    // `tick` is called from the render loop. An exception escaping it ends the
    // loop, which stops the writes, which leaves `Sidecar` re-sending one frame
    // to a floor nobody is driving any more. A decoder that will not close is a
    // leak; a render loop that stops is the show.
    expect(() => rig.engine.tick()).not.toThrow();
    expect(onWire(rig.engine.tick().wire)).toBe('b');
    expect(rig.source('a').disposed).toBe(true);
  });

  it('advances Standby past the cue that just went live', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    expect(rig.engine.snapshot().standbyCueId).toBe('a');

    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('b');

    rig.engine.go();
    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('c');
  });

  it('keeps a Standby the operator chose while the change was still in flight', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c'), cue('d')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('b');

    // GO, then a slow decode, and the operator uses that time to pick cue d.
    // The window in which the change is in flight is exactly the window in
    // which they have a moment to choose.
    rig.engine.go();
    rig.engine.selectCue('d');
    rig.run(10);
    expect(rig.engine.snapshot().standbyCueId).toBe('d');

    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('d');

    // And the choice is consumed by firing it, so the stack resumes stepping.
    rig.engine.go();
    rig.source('d').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().liveCueId).toBe('d');
    expect(rig.engine.snapshot().standbyCueId).toBe(null);
  });

  it('keeps a Standby chosen with the transport buttons across a change', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c'), cue('d')));
    rig.engine.go();
    rig.engine.selectNext();
    rig.engine.selectNext();
    expect(rig.engine.snapshot().standbyCueId).toBe('c');

    rig.source('a').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('c');
  });

  it('still advances Standby when the operator chose nothing', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('b');

    rig.engine.go();
    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().standbyCueId).toBe('c');
  });

  it('consumes a chosen Standby when a duration fires it, rather than sticking on it', () => {
    const rig = build(show(cue('a', 100), cue('b'), cue('c'), cue('d')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    // The operator picks cue d while a is running; a's duration then fires it
    // instead of GO. Firing is firing — the choice has been spent, so Standby
    // has to step past d rather than sitting on the cue already on the floor.
    rig.engine.selectCue('d');
    rig.advance(150);
    rig.engine.tick();
    rig.source('d').ready = true;
    rig.engine.tick();

    expect(rig.engine.snapshot().liveCueId).toBe('d');
    expect(rig.engine.snapshot().standbyCueId).toBe(null);
  });

  it('advances Standby past a cue that auto-advanced on its duration', () => {
    const rig = build(show(cue('a', 100), cue('b'), cue('c')));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.advance(150);
    rig.engine.tick();
    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().liveCueId).toBe('b');
    expect(rig.engine.snapshot().standbyCueId).toBe('c');
  });

  it('replaces an armed cue when GO is pressed again before it lands', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    rig.engine.goTo('b');
    rig.engine.goTo('c');
    expect(rig.source('b').disposed).toBe(true);

    rig.source('c').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('c');
  });
});

describe('preview has no path to the wire', () => {
  it('leaves the live cue on the floor while another cue is auditioned', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.source('b').ready = true;

    const tick = rig.engine.tick();
    expect(onWire(tick.wire)).toBe('a');
    expect(tick.screen.kind === 'source' ? tick.screen.source.cueId : null).toBe('b');
  });

  it('keeps the wire black when previewing with nothing live', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.source('b').ready = true;

    const tick = rig.engine.tick();
    expect(tick.wire.kind).toBe('black');
    expect(tick.screen.kind).toBe('source');
  });

  it('selecting a cue in preview does not change Standby', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    rig.engine.setMode('preview');
    rig.engine.selectCue('c');
    expect(rig.engine.snapshot().standbyCueId).toBe('a');
  });

  it('selecting a cue in live mode arms Standby and does not touch the floor', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.selectCue('c');
    expect(rig.engine.snapshot().standbyCueId).toBe('c');
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.sources.has('c')).toBe(false);
  });

  it('releases the preview decoder on the way back to live', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.engine.setMode('live');
    expect(rig.source('b').disposed).toBe(true);
    expect(rig.engine.tick().screen.kind).toBe('black');
  });

  it('shows black on screen while the previewed cue is still decoding', () => {
    const rig = build(show(cue('a')));
    rig.engine.setMode('preview');
    rig.engine.selectCue('a');
    expect(rig.engine.tick().screen.kind).toBe('black');
  });
});

describe('failures land on black, not on whatever is next', () => {
  it('keeps the live cue when the incoming one fails', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.source('b').disposed).toBe(true);
    expect(rig.engine.snapshot().lastError).toContain('Cue b');
  });

  it('goes black when the live cue dies, rather than advancing the stack', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.source('a').failed = true;
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.sources.has('b')).toBe(false);
  });

  it('goes black when the live cue is edited out of the show', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.setShow(show(cue('b')));
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.source('a').disposed).toBe(true);
    expect(rig.engine.snapshot().standbyCueId).toBe('b');
  });

  it('ignores GO and selection for cues that are not in the show', () => {
    const rig = build(show(cue('a')));
    rig.engine.goTo('nope');
    rig.engine.selectCue('nope');
    expect(rig.engine.snapshot().standbyCueId).toBe('a');
    expect(onWire(rig.engine.tick().wire)).toBe(null);
  });

  it('does nothing on GO with an empty stack', () => {
    const rig = build(show());
    rig.engine.go();
    expect(rig.run(3).map(onWire)).toEqual([null, null, null]);
  });
});

describe('transport and master', () => {
  it('freezes elapsed time and the decoder on pause, and keeps sending', () => {
    const rig = build(show(cue('a', 1_000)));
    rig.engine.go();
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.advance(400);
    rig.engine.setPaused(true);
    expect(rig.source('a').pauseCalls).toBe(1);

    rig.advance(5_000);
    // Paused past the cue's duration: the floor holds the paused frame, and it
    // holds it because frames are still being sent, not because sending stopped.
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.engine.snapshot().elapsedMs).toBe(400);

    rig.engine.setPaused(false);
    rig.advance(100);
    rig.engine.tick();
    expect(rig.engine.snapshot().elapsedMs).toBe(500);
    expect(rig.source('a').playCalls).toBe(2);
  });

  it('steps Standby without firing', () => {
    const rig = build(show(cue('a'), cue('b'), cue('c')));
    rig.engine.selectNext();
    expect(rig.engine.snapshot().standbyCueId).toBe('b');
    rig.engine.selectPrevious();
    expect(rig.engine.snapshot().standbyCueId).toBe('a');
    rig.engine.selectPrevious();
    expect(rig.engine.snapshot().standbyCueId).toBe('a');
    expect(rig.sources.size).toBe(0);
  });

  it('passes master through to the caller and refuses values outside 0..1', () => {
    const rig = build(show(cue('a')));
    expect(rig.engine.tick().master).toBe(1);
    rig.engine.setMaster(0.42);
    expect(rig.engine.tick().master).toBe(0.42);
    expect(() => rig.engine.setMaster(1.5)).toThrow(/master out of range/);
    expect(() => rig.engine.setMaster(-0.1)).toThrow(/master out of range/);
  });

  it('takes the player idle on stop and releases every decoder on dispose', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    rig.engine.goTo('b');

    rig.engine.stopPlayback();
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.source('a').disposed).toBe(true);
    expect(rig.source('b').disposed).toBe(true);

    rig.engine.setMode('preview');
    rig.engine.selectCue('a');
    rig.engine.dispose();
    expect(rig.source('a').disposed).toBe(true);
  });
});
