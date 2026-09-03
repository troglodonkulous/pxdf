import { describe, expect, it } from 'vitest';

import { frameVerdict } from '../electron/frameWatch';

/**
 * The renderer-liveness watchdog, and the two guards that stop it crying wolf.
 *
 * ## What it is for
 *
 * Nothing else in this app can distinguish a renderer that is gone from one
 * that is briefly busy. `Sidecar` re-sends its last frame for ever when nothing
 * new arrives — deliberately, so a stall does not black the floor — and every
 * other indicator agrees that all is well while it does: the status pill reads
 * `sending` and is correct, the Python child is healthy, the wire carries a
 * valid non-black frame, and no error is published because on that path nothing
 * threw. A React tree that unmounts takes `cancelAnimationFrame` with it and
 * the floor freezes with the whole UI reading green.
 *
 * ## The two guards, and why they are graded rather than assumed
 *
 * Both are the same failure in different clothes — a channel that fires when
 * nothing is wrong is a channel the operator learns to ignore, which is worse
 * than not having it. `CLAUDE.md` names this directly, and the leak warning
 * that fired on every clean teardown is the repo's own instance of it.
 *
 *   1. **Arming.** Before the window has loaded, and for a grace period after,
 *      no frames is the correct state and not a fault. A watchdog without this
 *      barks at every single launch.
 *
 *   2. **Banner ownership.** Copied from `nicVerdict`, whose test docstring has
 *      the measurement: a watcher that clears "the banner" rather than "its own
 *      banner" will wipe a sidecar death notice the moment its own unrelated
 *      condition recovers, and nothing re-raises a fault that is no longer
 *      happening. Here that is a dead sender behind a clean UI.
 *
 * MUTATION-CHECKED 2026-09-03: removing the `windowReadyAt === null` arm makes
 * the first test red; removing `currentBanner === lastWatchdogBanner` from
 * `clearBanner` makes "leaves another fault's banner alone" red.
 */
describe('frameVerdict', () => {
  const quiet = {
    lastFrameAt: null,
    windowReadyAt: null,
    now: 0,
    lastWatchdogBanner: null,
    currentBanner: null,
  } as const;

  it('says nothing while no window is up', () => {
    // The ordinary state between `before-quit` and exit, and on macOS after the
    // last window closes while the app stays alive. `main.ts` writes a black
    // frame on that path on purpose; a warning here would be reporting the app
    // doing exactly the right thing.
    expect(frameVerdict({ ...quiet, now: 60_000 }).banner).toBeNull();
  });

  it('gives a freshly loaded window time to draw its first frame', () => {
    expect(frameVerdict({ ...quiet, windowReadyAt: 0, now: 4_000 }).banner).toBeNull();
  });

  it('reports a window that loaded and never drew anything', () => {
    // The blank-window failure: `#root` empty because every asset 404'd. This
    // project shipped it once — see `vite.config.ts`'s note on `base: './'` —
    // and its own comment there says it produced "no error dialog, no console
    // the operator would ever see". This is that console.
    const { banner } = frameVerdict({ ...quiet, windowReadyAt: 0, now: 6_000 });
    expect(banner).toContain('never produced a frame');
  });

  it('says nothing while frames are arriving', () => {
    expect(
      frameVerdict({ ...quiet, windowReadyAt: 0, lastFrameAt: 9_900, now: 10_000 }).banner,
    ).toBeNull();
  });

  it('reports a renderer that stopped mid-show', () => {
    const { banner } = frameVerdict({ ...quiet, windowReadyAt: 0, lastFrameAt: 10_000, now: 12_500 });
    expect(banner).toContain('stopped producing frames');
    expect(banner).toContain('holding its last picture');
  });

  it('keeps the message byte-identical while the fault persists', () => {
    // The anti-flood property, and the reason the message carries no elapsed
    // counter. `main.ts` publishes on the edge by comparing against what it
    // last published, so a message that rewrote itself every tick would put a
    // banner and a log line on screen once a second for as long as the fault
    // lasted — the flood that trains an operator to stop reading both.
    const at = (now: number): string | null =>
      frameVerdict({ ...quiet, windowReadyAt: 0, lastFrameAt: 10_000, now }).banner;

    expect(at(13_000)).toBe(at(90_000));
  });

  it('clears the banner it put up once frames resume', () => {
    const raised = frameVerdict({ ...quiet, windowReadyAt: 0, lastFrameAt: 10_000, now: 12_500 });
    const recovered = frameVerdict({
      ...quiet,
      windowReadyAt: 0,
      lastFrameAt: 20_000,
      now: 20_100,
      lastWatchdogBanner: raised.watchdogBanner,
      currentBanner: raised.watchdogBanner,
    });

    expect(recovered.clearBanner).toBe(true);
    expect(recovered.watchdogBanner).toBeNull();
  });

  it('leaves another fault\'s banner alone', () => {
    // The guard `nicVerdict`'s docstring was written for. While the renderer was
    // frozen the sidecar died and published its own stderr through the same
    // channel. The renderer coming back must not wipe a notice of a sender that
    // has stopped trying — nothing re-raises a fault that is no longer
    // happening, and the result is a dead sender behind a clean UI.
    const raised = frameVerdict({ ...quiet, windowReadyAt: 0, lastFrameAt: 10_000, now: 12_500 });
    const recovered = frameVerdict({
      ...quiet,
      windowReadyAt: 0,
      lastFrameAt: 20_000,
      now: 20_100,
      lastWatchdogBanner: raised.watchdogBanner,
      currentBanner: 'sender exited with code 3',
    });

    expect(recovered.clearBanner).toBe(false);
  });

  it('does not clear a banner it never raised', () => {
    expect(
      frameVerdict({
        ...quiet,
        windowReadyAt: 0,
        lastFrameAt: 20_000,
        now: 20_100,
        currentBanner: 'sender exited with code 3',
      }).clearBanner,
    ).toBe(false);
  });
});
