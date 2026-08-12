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
import type { LinkStatus } from '../electron/sidecar';

/** A child process that behaves like a pipe: writable until told otherwise. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly writes: Uint8Array[] = [];
  /** Flip to make the next `write` report a full pipe, as Node's does. */
  acceptWrites = true;

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

  const statuses: LinkStatus[] = [];
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

    // The dropped frames are gone for good — the newest is what goes out.
    // A queue here would put stale frames on the wire after the drain and
    // leave the floor further behind real time with every stall, which is the
    // exact reason the Python side is a one-slot mailbox.
    expect(child.writes[1][0]).toBe(4);
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

    // Not cosmetic: controller 1 reverts to the vendor's own local content
    // ~5 s after packets stop, so a silent respawn that waits for the next
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

  it('resets the ladder after a spawn that survives', () => {
    // The bug this test was written for: without a reset, `retryIndex` is a
    // one-way ratchet. A sidecar that dies once at load-in and recovers leaves
    // the ladder parked at its 1 s hold, so an unrelated death hours later
    // waits a second instead of reconnecting immediately.
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    // Climb to the hold.
    for (let i = 0; i < 4; i++) {
      children[children.length - 1].die();
      vi.advanceTimersByTime(1_000);
    }
    const climbed = children.length;

    // Survive.
    children[climbed - 1].goLive();

    // Die again: this must be immediate, not a second later.
    children[climbed - 1].die();
    vi.advanceTimersByTime(0);
    expect(children.length).toBe(climbed + 1);
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

  it('reports dropped, then reconnecting, then linked', () => {
    const { sidecar, children, statuses } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    statuses.length = 0;

    children[0].die();
    expect(statuses).toEqual(['dropped', 'reconnecting']);
    vi.advanceTimersByTime(0);
    children[1].goLive();
    expect(statuses).toEqual(['dropped', 'reconnecting', 'linked']);
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
