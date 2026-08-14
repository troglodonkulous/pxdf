/**
 * The sidecar supervisor, graded without Electron and without Python.
 *
 * This file exists because PR 1's stated gate — the gradient24 digest, rotate
 * x4, mirror x2 — cannot see any of this code. All three run inside one
 * process, and every property below is about what happens *between* processes:
 * a renderer that outruns a pipe, a Python process that dies mid-show, a quit
 * that must not strand the final frame. The digest gate passing tells you
 * nothing about any of it, which is exactly the shape of result `CLAUDE.md`
 * warns about — a green instrument pointed away from the risk.
 *
 * `Sidecar` imports only `node:child_process`, so a fake `spawn` is enough.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

const { Sidecar } = await import('../electron/sidecar');
import type { SenderStatus } from '../electron/sidecar';

/** A child process that behaves like a pipe: writable until told otherwise. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly writes: Uint8Array[] = [];
  /** Flip to make the next `write` report a full pipe, as Node's does. */
  acceptWrites = true;
  /** A child that takes the signal but does not die yet. */
  ignoreKill = false;

  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: Uint8Array): boolean => {
      this.writes.push(Uint8Array.from(chunk));
      return this.acceptWrites;
    },
    end: vi.fn(() => {
      this.ended = true;
    }),
  });

  ended = false;

  kill(signal?: string): boolean {
    this.killed = true;
    if (this.ignoreKill) return true;
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  }

  /** Node emits `spawn` asynchronously; the supervisor waits for it. */
  goLive(): void {
    this.emit('spawn');
  }

  die(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
}

const BLACK = new Uint8Array(9600);

function makeSidecar() {
  const children: FakeChild[] = [];
  spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  const statuses: SenderStatus[] = [];
  const sidecar = new Sidecar({
    isPackaged: false,
    repoRoot: '/repo',
    type: '8x8_4P',
    cols: 10,
    rows: 5,
    blackFrame: BLACK,
    onStatus: (s) => statuses.push(s),
  });
  return { sidecar, children, statuses };
}

/**
 * Drain the microtask queue.
 *
 * A single `await Promise.resolve()` yields exactly one tick, which is not
 * enough for a `.then` hanging off an `async` method to run — and a test that
 * checks "has not resolved yet" after one tick reports "not yet" whether the
 * code is right or wrong. That is a test that cannot fail, and the first
 * version of the two below were exactly that: they survived a mutation that
 * resolved `stop()` on the signal instead of on the exit.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  spawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the command line it builds', () => {
  it('is the documented `mapper stream` invocation, at the repo root', () => {
    const { sidecar } = makeSidecar();
    sidecar.start();

    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('python3');
    expect(args).toEqual([
      '-m', 'mapper', 'stream',
      '--type', '8x8_4P',
      '--cols', '10',
      '--rows', '5',
      '--fps', '30',
      '--address', '127.0.0.1',
      '--port', '60001',
    ]);
    expect(opts.cwd).toBe('/repo');
  });

  it('defaults to loopback in development and broadcast when packaged', () => {
    // Not a preference. A developer machine that defaults to
    // 255.255.255.255 broadcasts onto whatever LAN it is plugged into, and at
    // a venue that is the floor.
    const { sidecar } = makeSidecar();
    sidecar.start();
    expect(spawn.mock.calls[0][1]).toContain('127.0.0.1');

    spawn.mockClear();
    const packaged = new Sidecar({
      isPackaged: true,
      repoRoot: '/repo',
      type: '8x8_4P',
      cols: 10,
      rows: 5,
      blackFrame: BLACK,
      onStatus: () => {},
    });
    packaged.start();
    expect(spawn.mock.calls[0][1]).toContain('255.255.255.255');
  });
});

describe('backpressure drops, it never queues', () => {
  it('stops writing once the pipe reports full, and resumes on drain', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();
    child.writes.length = 0;

    const a = new Uint8Array(9600).fill(1);
    const b = new Uint8Array(9600).fill(2);
    const c = new Uint8Array(9600).fill(3);

    child.acceptWrites = false;
    sidecar.writeFrame(a); // accepted, but reports the pipe is now full
    sidecar.writeFrame(b); // must be dropped, not buffered
    sidecar.writeFrame(c); // must be dropped, not buffered
    expect(child.writes.length).toBe(1);
    expect(child.writes[0][0]).toBe(1);

    child.acceptWrites = true;
    child.stdin.emit('drain');
    const d = new Uint8Array(9600).fill(4);
    sidecar.writeFrame(d);
    expect(child.writes.length).toBe(2);

    // What went out after the drain is the newest frame, not the backlog: b
    // and c never reach the pipe at all. (They are not erased from memory —
    // the newest of them stays in `lastFrame` and is what a respawn would
    // send, which is deliberate and tested below. The property here is about
    // the wire: no queue, so no stale frames arriving late and no floor
    // falling further behind real time with every stall.)
    expect(child.writes[1][0]).toBe(4);
  });
});

describe('the frame boundary', () => {
  // The wire format is headerless, so there is no resynchronisation point: a
  // single short or long write does not corrupt one frame, it offsets every
  // frame after it for the life of the process.
  it('drops anything that is not exactly one framebuffer', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();
    child.writes.length = 0;

    sidecar.writeFrame(new Uint8Array(9_599));
    sidecar.writeFrame(new Uint8Array(9_601));
    sidecar.writeFrame(new Uint8Array(0));
    expect(child.writes.length).toBe(0);

    sidecar.writeFrame(new Uint8Array(9_600).fill(5));
    expect(child.writes.length).toBe(1);
  });

  it('does not let a malformed frame become the one a respawn replays', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    children[0].goLive();

    sidecar.writeFrame(new Uint8Array(9_600).fill(9));
    sidecar.writeFrame(new Uint8Array(12));
    children[0].die();
    vi.advanceTimersByTime(0);
    children[1].goLive();

    expect(children[1].writes[0].byteLength).toBe(9_600);
    expect(children[1].writes[0][0]).toBe(9);
  });
});

describe('respawn', () => {
  it('writes the last frame the renderer produced as soon as it is back', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    children[0].goLive();

    const frame = new Uint8Array(9600).fill(7);
    sidecar.writeFrame(frame);
    children[0].die();

    vi.advanceTimersByTime(0);
    expect(children.length).toBe(2);
    children[1].goLive();

    // Not cosmetic: controller 1, in Master/IR mode, reverts to the vendor's
    // own local content ~5 s after packets stop (in slave mode it would hold
    // its last frame instead), so a silent respawn that waits for the next
    // rAF tick risks the floor showing someone else's show.
    expect(children[1].writes[0][0]).toBe(7);
  });

  it('sends black when the renderer has not produced a frame yet', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    expect(children[0].writes[0]).toEqual(BLACK);
  });

  it('walks the backoff ladder 0, 250, 500, 1000 and then holds', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    for (const delay of [0, 250, 500, 1_000, 1_000]) {
      const before = children.length;
      children[before - 1].die();
      if (delay > 0) {
        vi.advanceTimersByTime(delay - 1);
        expect(children.length, `respawned before ${delay}ms`).toBe(before);
      }
      vi.advanceTimersByTime(1);
      expect(children.length, `did not respawn at ${delay}ms`).toBe(before + 1);
    }
  });

  it('resets the ladder after a child that stays up', () => {
    // Without a reset, `retryIndex` is a one-way ratchet: a sidecar that dies
    // once at load-in and recovers leaves the ladder parked at its 1 s hold,
    // so an unrelated death hours later waits a second instead of
    // reconnecting immediately.
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    for (let i = 0; i < 4; i++) {
      children[children.length - 1].die();
      vi.advanceTimersByTime(1_000);
    }
    const climbed = children.length;

    children[climbed - 1].goLive();
    vi.advanceTimersByTime(5_000); // stayed up

    children[climbed - 1].die();
    vi.advanceTimersByTime(0);
    expect(children.length).toBe(climbed + 1);
  });

  it('does NOT reset the ladder for a child that dies as soon as it starts', () => {
    // The regression that the fix above first introduced. `spawn` fires on
    // process creation and proves nothing about survival, so resetting there
    // turns a permanently-failing sidecar — bad geometry, missing module, port
    // already held — into an unbounded 0 ms respawn loop.
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    for (const delay of [0, 250, 500, 1_000, 1_000]) {
      const before = children.length;
      children[before - 1].goLive(); // created...
      children[before - 1].die(); // ...and immediately gone
      if (delay > 0) {
        vi.advanceTimersByTime(delay - 1);
        expect(children.length, `respawned before ${delay}ms`).toBe(before);
      }
      vi.advanceTimersByTime(1);
      expect(children.length).toBe(before + 1);
    }
  });

  it('kills a child that errored but is still running, before starting another', () => {
    // A stdin error is not proof of death. Spawning a replacement beside a
    // live child puts two senders on one broadcast address.
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();

    child.stdin.emit('error', new Error('EPIPE'));
    expect(child.killed).toBe(true);
    vi.advanceTimersByTime(0);
    expect(children.length).toBe(2);
  });

  it('never gives up', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    for (let i = 0; i < 50; i++) {
      children[children.length - 1].die();
      vi.advanceTimersByTime(1_000);
    }
    // An unattended show has to recover on its own; there is no operator to
    // press a button at 23:40.
    expect(children.length).toBe(51);
  });

  it('reports stopped, then restarting, then sending', () => {
    const { sidecar, children, statuses } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    vi.advanceTimersByTime(500);
    statuses.length = 0;

    children[0].die();
    // `restarting` waits for the ladder's delay to elapse and a child to
    // actually be started. Nothing is coming up during the delay, and `stopped`
    // is the accurate word for that.
    expect(statuses).toEqual(['stopped']);
    vi.advanceTimersByTime(0);
    expect(statuses).toEqual(['stopped', 'restarting']);
    children[1].goLive();
    // Not yet. `spawn` fires on process creation, so a status published here
    // would say nothing more than the old 'linked' did.
    expect(statuses).toEqual(['stopped', 'restarting']);
    vi.advanceTimersByTime(500);
    expect(statuses).toEqual(['stopped', 'restarting', 'sending']);
  });

  it('does not leave a replaced sidecar reading sending', () => {
    // `main.ts` swaps the whole instance for a floor or NIC change, and
    // `stop()` publishes nothing — so whatever the previous child last said
    // stands until the new one speaks. While that was `spawn` the gap was
    // negligible; with the promotion deferred it is a window in which the
    // indicator claims a process that has already been killed is sending.
    const first = makeSidecar();
    first.sidecar.start();
    first.children[0].goLive();
    vi.advanceTimersByTime(500);
    expect(first.statuses.at(-1)).toBe('sending');

    // The replacement instance. Its first published word has to displace the
    // stale one, and it must not be `sending`.
    const replacement = makeSidecar();
    replacement.sidecar.start();
    expect(replacement.statuses).toEqual(['restarting']);

    // And it still reaches sending on its own account, so this is a correction
    // rather than a mute.
    replacement.children[0].goLive();
    vi.advanceTimersByTime(500);
    expect(replacement.statuses).toEqual(['restarting', 'sending']);
  });

  it('never says sending for a child that dies on startup', () => {
    // The crash loop this exists for: an illegal geometry, or a --local-ip
    // naming an interface that has gone away, makes `mapper stream` exit on its
    // next tick. The retry ladder's first rung is 0 ms, so publishing from
    // `spawn` strobed the indicator through Sending several times a second
    // while nothing was leaving the machine — and an indicator that cries wolf
    // once is one an operator reads straight past on the night it is right.
    const { sidecar, children, statuses } = makeSidecar();
    sidecar.start();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      children[attempt].goLive();
      children[attempt].die();
      vi.advanceTimersByTime(1_000);
    }

    expect(statuses).not.toContain('sending');
    // The positive control. An assertion that something is absent passes just
    // as well when nothing happened at all, so prove the loop ran.
    expect(children.length).toBeGreaterThan(4);
    expect(statuses.filter((status) => status === 'stopped').length).toBe(4);
  });
});

describe('stop', () => {
  it('ends stdin rather than killing, so the last frame reaches the wire', async () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();

    const stopped = sidecar.stop();
    expect(child.ended).toBe(true);
    expect(child.killed).toBe(false);

    child.die();
    await stopped;
  });

  it('writes black before ending stdin, so the floor is not left lit', async () => {
    // Ending stdin makes the sidecar put its *last* frame on the wire and
    // exit; controllers 2 and 3 then hold that frame indefinitely. Quitting
    // mid-show would otherwise leave the floor showing whatever was up, with
    // nothing left running to change it.
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();
    sidecar.writeFrame(new Uint8Array(9_600).fill(200));
    child.writes.length = 0;

    const stopped = sidecar.stop();
    expect(child.writes.length).toBe(1);
    expect(child.writes[0]).toEqual(BLACK);
    expect(child.ended).toBe(true);

    child.die();
    await stopped;
  });

  it('falls back to SIGKILL if the child will not go within 2 s', async () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();

    const stopped = sidecar.stop();
    expect(child.killed).toBe(false);
    vi.advanceTimersByTime(2_000);
    await stopped;
    expect(child.killed).toBe(true);
  });

  it('does not resolve on the SIGKILL itself, only once the child is gone', async () => {
    // Resolving on the signal lets the app quit while the child is still
    // dying, which is how a sender outlives its parent and keeps broadcasting
    // to a floor nobody is driving.
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();
    child.ignoreKill = true;

    let resolved = false;
    void sidecar.stop().then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(2_000); // SIGKILL sent
    await flushMicrotasks();
    expect(child.killed).toBe(true);
    expect(resolved).toBe(false);

    child.die();
    await flushMicrotasks();
    expect(resolved).toBe(true);
  });

  it('hands a second caller the same shutdown rather than resolving early', async () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();
    child.ignoreKill = true;

    let secondResolved = false;
    const first = sidecar.stop();
    void sidecar.stop().then(() => {
      secondResolved = true;
    });

    await flushMicrotasks();
    expect(secondResolved).toBe(false);

    child.die();
    await first;
    await flushMicrotasks();
    expect(secondResolved).toBe(true);
  });

  it('does not respawn a child that exited because we stopped it', async () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    children[0].goLive();

    const stopped = sidecar.stop();
    children[0].die();
    await stopped;
    vi.advanceTimersByTime(10_000);
    expect(children.length).toBe(1);
  });
});
