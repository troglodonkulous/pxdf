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

  let sourceThrows = false;

  const engine = new PlayerEngine<FakeSource>({
    show: s,
    now: () => clock,
    createSource: (c) => {
      if (sourceThrows) {
        sourceThrows = false;
        throw new Error(`no decoder for ${c.id}`);
      }
      const source = new FakeSource(c.id);
      sources.set(c.id, source);
      created.set(c.id, (created.get(c.id) ?? 0) + 1);
      return source;
    },
  });

  return {
    engine,
    sources,
    /**
     * Make the next `createSource` throw, once.
     *
     * A real one can: `createSource` is `new VideoSource(path)` and the
     * constructor touches the DOM. What matters is not how likely that is but
     * where it lands — `arm` runs on the tick path once a cue has a duration,
     * and the tick path is the render loop.
     */
    failNextSourceOnce: (): void => {
      sourceThrows = true;
    },
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

/**
 * Editing a cue that is already on the floor.
 *
 * `setShow` used to ask one question of the new show — does this cue still
 * exist — and tear the slot down if not. A cue that still existed was left
 * alone, meaning the slot went on holding the `Cue` object it captured at
 * `arm()`. Change a live cue's duration and nothing happened: the engine was
 * still reading the duration the cue had when GO was pressed, and it would keep
 * doing so until the cue was fired again.
 *
 * That is the defect that makes an inspector control feel broken rather than
 * look broken -- the field takes the number, the show file holds the number,
 * and the floor ignores it.
 *
 * The refresh has to be surgical: swap the cue metadata, keep the decoder. A
 * re-arm would restart the clip from zero, so trimming a cue's length would
 * also jump the floor back to its first frame.
 */
describe('editing a cue reaches the slot already playing it', () => {
  it('takes a new duration on the live cue without rebuilding the decoder', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().cueDurationMs).toBe(null);

    rig.engine.setShow(show({ ...cue('a'), durationMs: 5_000 }, cue('b')));
    expect(rig.engine.snapshot().cueDurationMs).toBe(5_000);
    expect(rig.created('a')).toBe(1);
    expect(rig.source('a').disposed).toBe(false);
  });

  it('honours the edited duration, rather than the one captured at GO', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.setShow(show({ ...cue('a'), durationMs: 5_000 }, cue('b')));
    rig.advance(5_000);
    rig.engine.tick();
    // The edit is only real if the advance actually fires on it.
    expect(rig.engine.snapshot().pendingCueId).toBe('b');
  });

  it('advances on the next tick when the new duration is already spent', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    rig.advance(30_000);

    // Trimming a cue to shorter than it has already been running is an ordinary
    // edit during a load-in, and the only sane reading of it is "this cue is
    // over". It must not wait, and it must not wrap around into a negative
    // remaining time.
    rig.engine.setShow(show({ ...cue('a'), durationMs: 2_000 }, cue('b')));
    rig.engine.tick();
    expect(rig.engine.snapshot().pendingCueId).toBe('b');
  });

  it('refreshes the pending and preview slots too', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    // `a` is armed but not ready, so it is pending rather than live.
    rig.engine.setShow(show({ ...cue('a'), name: 'renamed' }, cue('b')));
    rig.source('a').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('renamed');
    expect(rig.created('a')).toBe(1);

    const preview = build(show(cue('a')));
    preview.engine.setMode('preview');
    preview.engine.selectCue('a');
    preview.engine.setShow(show({ ...cue('a'), name: 'also renamed' }));
    preview.source('a').failed = true;
    preview.engine.tick();
    expect(preview.engine.snapshot().lastError).toContain('also renamed');
    expect(preview.created('a')).toBe(1);
  });

  it('advances past the live cue when Standby is the live cue', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    // Selecting a cue is how Standby is armed, and selecting the *live* cue is
    // exactly what an operator does to edit its length in the inspector. A
    // timed advance fires Standby, so this used to re-arm the cue that was
    // already playing: the clip restarted every N seconds, for ever, with
    // nothing to say why. Restarting on a timer is Loop, it is PR 4, and it is
    // not what a control labelled Duration promises.
    rig.engine.selectCue('a');
    rig.engine.setShow(show({ ...cue('a'), durationMs: 1_000 }, cue('b')));
    rig.advance(1_000);
    rig.engine.tick();

    expect(rig.engine.snapshot().pendingCueId).toBe('b');
    expect(rig.created('a')).toBe(1);

    // Graded on the wire and not only on the slot. `pendingCueId === 'b'` is an
    // internal symptom, and it stays true for an advance that takes the floor
    // black on its way — arming `b` while dropping `a` satisfies every
    // assertion above and gaps the floor for as long as `b` takes to decode.
    // What the operator sees is `a`, then `b`, and never black between them.
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    rig.source('b').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('b');
  });

  it('goes black rather than looping when the live cue is the only one left', () => {
    const rig = build(show(cue('a')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    rig.engine.selectCue('a');
    rig.engine.setShow(show({ ...cue('a'), durationMs: 1_000 }));
    rig.advance(1_000);

    // Nothing after it, so the stack has ended. Idle is black and the send
    // continues; re-arming itself would be a one-cue show that never stops.
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.created('a')).toBe(1);
  });

  it('does not throw out of tick when a decoder cannot be built', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    rig.engine.setShow(show({ ...cue('a'), durationMs: 1_000 }, cue('b')));
    rig.advance(1_000);

    // `arm` runs on the tick path here, and the tick path is the render loop.
    // An exception out of `tick()` skips that frame's `writeFrame` — and since
    // the duration stays expired, it skips every frame after it too, while
    // `Sidecar` re-sends its last frame to a floor nobody is driving. The
    // engine must turn this into black plus a banner, like any other failure.
    rig.failNextSourceOnce();
    expect(() => rig.engine.tick()).not.toThrow();
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.engine.snapshot().lastError).toContain('Cue b');

    // And it must not spin: having gone idle, there is no duration left to
    // expire, so no further decoders are attempted.
    const attempts = rig.created('b');
    rig.advance(5_000);
    rig.engine.tick();
    rig.engine.tick();
    expect(rig.created('b')).toBe(attempts);
  });

  it('still tears down a slot whose cue was deleted', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.setShow(show(cue('b')));
    expect(rig.source('a').disposed).toBe(true);
    expect(onWire(rig.engine.tick().wire)).toBe(null);
  });
});

/**
 * The error banner is the only channel this player has for "the thing you asked
 * for did not happen", so what makes it disappear has to be the thing actually
 * happening — not the operator asking a second time.
 *
 * The original rule was "cleared by the next GO", cleared at arm time. That
 * reports success at the moment of the *request*: press GO on a cue that cannot
 * decode and the banner clears, then repopulates a frame or two later when the
 * decoder gives up. A banner that blanks and comes back reads, in the only
 * moment anyone is looking at it, as a problem that resolved itself.
 *
 * So an error is now tied to the surface it happened on, and clears when that
 * surface is either working again or gone. The two surfaces resolve differently
 * and the asymmetry is load-bearing:
 *
 *   - Live resolves on the *promotion*, a transition. It cannot be the state
 *     `live !== null && ready`, because a pending cue can fail while an older
 *     cue is still happily on the wire — and that state is true on the very
 *     next tick, which would erase the error one frame after setting it.
 *   - Preview resolves on the *state* `preview.ready`, which is safe only
 *     because a failed preview is released in the same tick that records it,
 *     so a ready preview is never the one the error is about.
 */
describe('the error banner tracks the failure, not the button press', () => {
  /** Live cue a dies. Floor is black, banner explains why. */
  function liveFailure() {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.source('a').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
    return rig;
  }

  it('holds the error while the recovering cue is still decoding', () => {
    const rig = liveFailure();

    rig.engine.goTo('b');
    // GO is a request, not an outcome: nothing has reached the floor yet, and
    // the floor is still black. Clearing here is the defect this test exists
    // for -- it announces a recovery that has not happened.
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
  });

  // Green against the broken engine too, because clearing at arm time also
  // ends with a clear banner here. It is evidence of nothing on its own -- what
  // separates the two is the test above, which asserts *when*. Kept as the
  // other half of that pair: one says the banner clears, one says not yet.
  it('clears the error when the recovering cue reaches the wire', () => {
    const rig = liveFailure();

    rig.engine.goTo('b');
    rig.source('b').ready = true;
    expect(onWire(rig.engine.tick().wire)).toBe('b');
    expect(rig.engine.snapshot().lastError).toBe(null);
  });

  it('never blanks the banner when the recovering cue fails too', () => {
    const rig = liveFailure();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    // The banner changes what it says without ever going empty: one failure is
    // replaced by the next, and there is no frame in between that reads clean.
    expect(rig.engine.snapshot().lastError).not.toBe(null);
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue b');
  });

  it('clears a preview error once a preview decodes', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.setMode('preview');

    rig.engine.selectCue('a');
    rig.source('a').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue a');

    rig.engine.selectCue('b');
    rig.source('b').ready = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toBe(null);
  });

  it('clears a preview error on leaving preview, where the surface goes away', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.setMode('preview');
    rig.engine.selectCue('a');
    rig.source('a').failed = true;
    rig.engine.tick();

    rig.engine.setMode('live');
    // The decoder is released and the surface is off screen. An error about it
    // would otherwise sit on the banner for the rest of the session.
    expect(rig.engine.snapshot().lastError).toBe(null);
  });

  it('does not let a working preview clear an error about a black floor', () => {
    const rig = liveFailure();

    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.source('b').ready = true;
    rig.engine.tick();

    // This is the reason errors carry a surface at all. The preview is fine and
    // the floor is still black; one flat error cleared by any success would
    // take the banner down and leave the operator reading a healthy preview as
    // if it were the floor.
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
  });

  it('does not let a preview failure erase an error about a black floor', () => {
    const rig = liveFailure();

    // One error slot and two surfaces was the first shape of this, and it had
    // a hole the size of the defect it was built to prevent: tagging the error
    // stopped a preview *success* from clearing a live error, and did nothing
    // about a preview *failure* overwriting it. The floor is black from `a`,
    // the operator previews `b` to find something to put up, `b` will not
    // decode either -- and leaving preview then cleared a banner that was, by
    // that point, the only thing saying the floor was dark.
    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.source('b').failed = true;
    rig.engine.tick();

    rig.engine.setMode('live');
    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
  });

  it('shows the live failure first when both surfaces have one', () => {
    const rig = liveFailure();
    rig.engine.setMode('preview');
    rig.engine.selectCue('b');
    rig.source('b').failed = true;
    rig.engine.tick();

    // Both are true; only one fits on the banner. The floor is the show.
    expect(rig.engine.snapshot().lastError).toContain('Cue a');
  });

  it('keeps a pending failure up while the older cue keeps playing', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue b');

    // `a` is live and ready on this tick and every tick after it. Resolving the
    // live surface from that state rather than from the promotion would clear
    // the banner here, one frame after it was set, with `b` still not playing.
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.engine.snapshot().lastError).toContain('Cue b');
  });

  it('retires a failure when its cue is deleted, and keeps the floor running', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue b');

    // Deleting the clip that would not play is what an operator does next, and
    // the banner then names a cue that is not in the stack: unactionable, and
    // up until the next successful GO over a floor that is working perfectly.
    rig.engine.setShow(show(cue('a')));
    expect(rig.engine.snapshot().lastError).toBe(null);
    expect(onWire(rig.engine.tick().wire)).toBe('a');
  });

  it('keeps a failure up while its cue is still in the stack, under its new name', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    rig.engine.tick();

    // Two things at once, and they pull in opposite directions. Retiring on any
    // `setShow` at all would erase a live failure the moment the operator
    // renamed an unrelated cue — the *deletion* of this cue is the event, not
    // the edit. But the banner is a sentence about a cue, and a sentence built
    // when the failure happened goes on using a name the operator has since
    // changed and can no longer find in the stack. So the failure survives the
    // rename and the wording follows it.
    rig.engine.setShow(show(cue('a'), { ...cue('b'), name: 'Intro' }));
    const banner = rig.engine.snapshot().lastError;
    expect(banner).toContain('Intro');
    expect(banner).not.toContain('Cue b');
  });

  it('retires a failure when the cue is given different media', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    rig.engine.goTo('b');
    rig.source('b').failed = true;
    rig.engine.tick();
    expect(rig.engine.snapshot().lastError).toContain('Cue b');

    // Swapping a working clip in is the other thing an operator does about a
    // cue that will not play, and the failure is about a cue *and a file*. Kept
    // here, the banner condemns media nothing has tried yet — it reports the
    // new clip broken on the strength of the old one.
    const replaced: Cue = { ...cue('b'), source: { kind: 'video', path: '/media/fixed.mp4' } };
    rig.engine.setShow(show(cue('a'), replaced));
    expect(rig.engine.snapshot().lastError).toBe(null);
  });
});

describe('a cue whose media changed is not the cue that is playing', () => {
  it('tears down the live slot rather than keeping the old decoder', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();
    expect(onWire(rig.engine.tick().wire)).toBe('a');

    // Same id, different file. Reseating the slot here would leave the decoder
    // for `/media/a.mp4` running under a cue that now names another file: the
    // floor shows the old clip, the UI shows the new cue, and nothing anywhere
    // reports a problem. It just looks like the wrong clip, which is the one
    // failure mode with no channel at all.
    const replaced: Cue = { ...cue('a'), source: { kind: 'video', path: '/media/other.mp4' } };
    rig.engine.setShow(show(replaced, cue('b')));

    expect(onWire(rig.engine.tick().wire)).toBe(null);
    expect(rig.source('a').disposed).toBe(true);
  });

  it('leaves a cue whose media is unchanged on the wire', () => {
    const rig = build(show(cue('a'), cue('b')));
    rig.engine.goTo('a');
    rig.source('a').ready = true;
    rig.engine.tick();

    // The positive control for the check above: an ordinary edit must not tear
    // anything down, or the guard would be indistinguishable from `setShow`
    // always going idle.
    rig.engine.setShow(show({ ...cue('a'), name: 'Renamed' }, cue('b')));
    expect(onWire(rig.engine.tick().wire)).toBe('a');
    expect(rig.source('a').disposed).toBe(false);
    expect(rig.created('a')).toBe(1);
  });
});
