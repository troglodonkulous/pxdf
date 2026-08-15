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

  /**
   * Present because the supervisor now reads it. Until this PR the child was
   * spawned with stderr `'inherit'`, so `mapper`'s own account of why it died
   * went to a terminal the operator is not looking at — the only thing the UI
   * ever learned was a three-valued status flickering between Stopped and
   * Restarting. `setEncoding` is here because `sidecar.ts` calls it.
   */
  readonly stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
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

/** Mirrors `STABLE_AFTER_MS` in `sidecar.ts`, which is module-private there. */
const STABLE_AFTER_MS = 5_000;

function makeSidecar() {
  const children: FakeChild[] = [];
  spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  const statuses: SenderStatus[] = [];
  const errors: (string | null)[] = [];
  const sidecar = new Sidecar({
    isPackaged: false,
    repoRoot: '/repo',
    type: '8x8_4P',
    cols: 10,
    rows: 5,
    blackFrame: BLACK,
    onStatus: (s) => statuses.push(s),
    onError: (message) => errors.push(message),
  });
  return { sidecar, children, statuses, errors };
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

  it('walks the backoff ladder 0, 250, 500, 1000, 2000, 5000 and then holds', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    for (const delay of [0, 250, 500, 1_000, 2_000, 5_000, 5_000]) {
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
      vi.advanceTimersByTime(5_000);
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

    for (const delay of [0, 250, 500, 1_000, 2_000, 5_000, 5_000]) {
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
      vi.advanceTimersByTime(5_000);
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

/**
 * MEASURED 2026-08-13. Pulling the Ethernet with the app open put the sender
 * into a permanent respawn storm: `mapper stream` cannot bind to an address no
 * interface holds, so every child died on arrival, and the ladder brought
 * another one up a second later, forever. Each death was a macOS crash dialog
 * (see `mapper/tests/test_stream_exit.py` for that half). The operator's only
 * way out was killing the app from a terminal.
 *
 * Widening the ladder would only have slowed the storm down. The fix is that a
 * process which *cannot* succeed is not started at all: `main.ts` watches the
 * interface list and suspends the supervisor while the bound address is absent.
 * That is a policy about the machine's NICs, so it lives in `main.ts` and
 * arrives here as two calls — `node:os` stays out of this file.
 */
describe('suspend and resume', () => {
  it('brings up no child at all while suspended', () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    expect(children.length).toBe(1);

    sidecar.suspend('10.200.50.78 is gone');
    children[0].die();

    // Five minutes at the top of the ladder is 60 spawns unsuspended.
    vi.advanceTimersByTime(300_000);
    expect(children.length, 'respawned while suspended').toBe(1);
  });

  it('kills a child that is still running when it suspends', () => {
    // `sendto` on a socket bound to a departed address does not reliably fail,
    // so a child can outlive its own interface, holding a socket that will not
    // work again when the cable comes back. Resume has to build a fresh one.
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    vi.advanceTimersByTime(500);

    sidecar.suspend('10.200.50.78 is gone');
    expect(children[0].killed).toBe(true);
    vi.advanceTimersByTime(300_000);
    expect(children.length).toBe(1);
  });

  it('says stopped while suspended, and gives the reason', () => {
    const { sidecar, statuses, errors } = makeSidecar();
    sidecar.start();
    statuses.length = 0;
    errors.length = 0;

    sidecar.suspend('10.200.50.78 is gone');

    expect(statuses).toContain('stopped');
    expect(statuses, 'claimed something was coming up').not.toContain('restarting');
    expect(errors.at(-1)).toContain('10.200.50.78');
  });

  it('comes back on its own when the interface returns', () => {
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    sidecar.suspend('10.200.50.78 is gone');
    children[0].die();
    vi.advanceTimersByTime(300_000);

    sidecar.resume();

    // At once, not on the rung the storm had climbed to. There is no operator
    // at 23:40 and the floor is dark until this happens.
    expect(children.length).toBe(2);
    expect(errors.at(-1), 'left an error banner up over a working sender').toBe(null);
  });

  it('is idempotent in both directions', () => {
    // `main.ts` polls, so it calls these on a timer with whatever the current
    // answer is rather than on an edge. A second `resume` must not spawn a
    // second sender onto one broadcast address.
    const { sidecar, children } = makeSidecar();
    sidecar.start();

    sidecar.suspend('gone');
    sidecar.suspend('gone');
    children[0].die();
    vi.advanceTimersByTime(10_000);
    expect(children.length).toBe(1);

    sidecar.resume();
    sidecar.resume();
    sidecar.resume();
    expect(children.length).toBe(2);
  });

  it('does not resurrect a sidecar that was stopped for good', async () => {
    const { sidecar, children } = makeSidecar();
    sidecar.start();
    const stopped = sidecar.stop();
    children[0].emit('exit', 0, null);
    await stopped;

    sidecar.resume();
    vi.advanceTimersByTime(10_000);
    expect(children.length, 'resume outranked stop').toBe(1);
  });
});

/**
 * The child's own account of why it died, which until now went nowhere.
 *
 * `stdio` stderr was `'inherit'`, so `mapper`'s message landed on the Electron
 * main process's console. Every postmortem in `docs/POSTMORTEMS.md` is a
 * contradiction that had no path to a reader; this was one waiting to happen,
 * and the Ethernet incident is where it happened.
 */
describe('the reason a child died', () => {
  it('reports what the child said on stderr', () => {
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    const child = children[0];
    child.goLive();

    child.stderr.emit('data', 'floor NIC 10.200.50.78 unusable: [Errno 49] Cannot assign requested address\n');
    child.die();

    expect(errors.at(-1)).toContain('Errno 49');
  });

  it('keeps the last lines, not the first', () => {
    // A traceback or a run of warnings must not push the line that names the
    // fault out of the message the operator reads.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    children[0].goLive();

    for (let i = 0; i < 40; i++) children[0].stderr.emit('data', `noise ${i}\n`);
    children[0].stderr.emit('data', 'floor NIC 10.200.50.78 unusable\n');
    children[0].die();

    expect(errors.at(-1)).toContain('10.200.50.78');
    expect(errors.at(-1)).not.toContain('noise 0');
  });

  it('reports a child that never started and said nothing', () => {
    // `spawn python3 ENOENT` — a wrong venv, or no Python on `PATH` at all.
    // No process is created, so there is not one byte of stderr to gate on,
    // and the `Error` carrying ENOENT arrived in a parameter the handler did
    // not take. The whole account of the failure was therefore dropped, and
    // the operator watched the pill cycle Stopped → Restarting forever with a
    // blank banner over it. This is the commonest way a machine that has never
    // run the app fails, and it was the one death that said least.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();

    children[0].emit('error', new Error('spawn python3 ENOENT'));

    expect(errors.at(-1)).toContain('ENOENT');
  });

  it('reports a child that exited silently', () => {
    // The other half of the same hole: a nonzero exit that prints nothing —
    // a signal kill, or an exit path that returns before it can write. Exit
    // code 3 is not the case that matters here; `mapper/cli.py:515` prints
    // before `_exit_now(EXIT_NETWORK_GONE)`, so on that path stderr already
    // has the message. It is the silent ones this covers.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    children[0].goLive();

    children[0].die(); // exit(1, null), nothing on stderr

    expect(errors.at(-1)).toContain('code 1');
  });

  it('attributes a silent death to itself, keeping the earlier cause as history', () => {
    // Stale attribution. Child N dies with stderr; child N+1 dies mute. Left
    // to stand alone, N's message now describes a death that did not happen
    // that way — while erasing it would throw away the only explanation the
    // crash loop ever produced. The message has to do both: name this death,
    // and quote the earlier one as prior.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    children[0].stderr.emit('data', 'floor NIC 10.200.50.78 unusable\n');
    children[0].die();

    vi.advanceTimersByTime(0);
    children[1].goLive();
    children[1].die(); // says nothing of its own

    expect(errors.at(-1)).toContain('code 1');
    expect(errors.at(-1)).toContain('10.200.50.78');
  });

  it('clears the error once a replacement has stayed up', () => {
    // A banner that outlives its cause is the cry-wolf failure in `CLAUDE.md`:
    // one channel left permanently red trains the operator to ignore it, and
    // the true one after that is ignored too.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    children[0].stderr.emit('data', 'something went wrong\n');
    children[0].die();
    expect(errors.at(-1)).toContain('something went wrong');

    vi.advanceTimersByTime(0);
    children[1].goLive();
    vi.advanceTimersByTime(STABLE_AFTER_MS);

    expect(errors.at(-1), 'error outlived the failure it described').toBe(null);
  });

  it('does not clear the error on a child that dies before it is stable', () => {
    // The mutation that the fix above invites: clearing on `spawn` rather than
    // on survival wipes the banner on every rung of a crash loop, so a floor
    // that never comes up reads as one with nothing wrong.
    const { sidecar, children, errors } = makeSidecar();
    sidecar.start();
    children[0].goLive();
    children[0].stderr.emit('data', 'something went wrong\n');
    children[0].die();

    vi.advanceTimersByTime(0);
    children[1].goLive();
    vi.advanceTimersByTime(STABLE_AFTER_MS - 1);
    children[1].die();

    // Asserted positively on purpose. `not.toBe(null)` is satisfied by
    // `undefined`, so the first version of this passed against an
    // implementation that had never published an error at all — a check that
    // could not fail, guarding the fix most likely to break it.
    expect(errors.at(-1)).toContain('something went wrong');
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
