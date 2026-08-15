import { describe, expect, it } from 'vitest';

import { nicVerdict } from '../electron/nicWatch';

/**
 * Whether the bound NIC is present is a question about the machine, and the
 * answer has to survive the sender being replaced underneath it.
 *
 * MEASURED by review 2026-08-14, on this branch, before it was opened. The
 * suspend/resume policy in `main.ts` was edge-triggered through the `Sidecar`
 * instance: the poll called `suspend()` when the bound address vanished and
 * `resume()` when it came back, and `resume()` is what cleared the error
 * banner. `Sidecar.resume()` returns early unless that same instance is
 * suspended:
 *
 *     resume(): void {
 *       if (!this.suspended || this.stopping || !this.started) return
 *
 * which is correct for one instance and wrong across two. `doSetFloor` throws
 * the whole sidecar away and builds a new one, and a new one has
 * `suspended === false`. So:
 *
 *   1. the laptop boots at the venue before anyone patches the cable, the poll
 *      suspends, and the banner goes up — all correct;
 *   2. the operator sets the job geometry, and `main.ts` replaces the sidecar;
 *   3. the cable is patched, the poll calls `resume()` on an instance that was
 *      never suspended, and it returns at the first clause.
 *
 * The floor is sending. The banner still says the NIC is gone, and nothing
 * will ever take it down.
 *
 * The fix is that the verdict is level-triggered and owned here rather than
 * inferred from a transition on an object that does not outlive the fault.
 *
 * SECOND DEFECT, found by review of that fix, 2026-08-14. The first cut
 * carried a boolean `wasGone` and cleared on `wasGone && !gone` — which clears
 * whatever banner is currently up, not the one the poll raised. A comment in
 * `nicWatch.ts` claimed it protected the sender's own errors. It did not; it
 * only protected the case where the NIC had never been gone at all.
 *
 * The path that matters: the NIC goes away and the poll banners it. The
 * operator changes the floor, so `doSetFloor` builds a replacement sidecar,
 * and a replacement is not suspended — it spawns a child before the queued
 * verdict reaches it. That child fails and publishes its own stderr through
 * the same channel, so the banner is now a real and unrelated fault. If that
 * fault is the terminal one this branch added — the sender that has stopped
 * trying because it cannot succeed — then the NIC coming back wipes the only
 * notice of it, and nothing re-raises it, because nothing is running to fail
 * again. A dead sender with a clean UI.
 *
 * So the poll may only take down the banner it put up. It carries the message
 * it published rather than a flag, and clears only while that exact message is
 * still the one on screen.
 */
describe('nicVerdict', () => {
  const EN18 = { name: 'en18', address: '10.200.50.78' };
  const WIFI = { name: 'en0', address: '192.168.1.40' };
  const GONE = 'floor NIC 10.200.50.78 is no longer assigned to any interface — check the cable';

  it('suspends, naming the address, while the bound NIC is absent', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI], null, null);

    expect(verdict.suspend).toContain('10.200.50.78');
    expect(verdict.nicBanner, 'did not remember what it put up').toBe(verdict.suspend);
  });

  it('resumes once the bound NIC is back', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], GONE, GONE);

    expect(verdict.suspend).toBe(null);
    expect(verdict.nicBanner).toBe(null);
  });

  /**
   * The first regression. `resume()` on a replacement sidecar is a no-op, so
   * the instruction to take the banner down cannot be carried by it.
   */
  it('clears the banner itself when the NIC returns, not via resume', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], GONE, GONE);

    expect(verdict.clearBanner, 'left an error banner up over a working sender').toBe(true);
  });

  /**
   * The second regression, and the more dangerous one. A terminal sender error
   * raised while the NIC was away must outlive the NIC coming back — there is
   * nothing running to raise it a second time.
   */
  it('does not clear a banner raised by something else while the NIC was away', () => {
    const senderDied = 'sender stopped for good: mapper exited 1 — python3: command not found';
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], GONE, senderDied);

    expect(verdict.clearBanner, 'wiped a terminal sender error on NIC recovery').toBe(false);
    // Still forgets its own banner: that message is gone from the screen and
    // will never be the thing to clear again.
    expect(verdict.nicBanner).toBe(null);
  });

  it('does not clear a banner it never raised', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], null, 'some other fault');

    expect(verdict.suspend).toBe(null);
    expect(verdict.clearBanner, 'stomped an error from another source').toBe(false);
  });

  it('does not clear when the banner is already down', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], GONE, null);

    expect(verdict.clearBanner, 'published a redundant null').toBe(false);
  });

  it('leaves the sender alone when no NIC is pinned', () => {
    // The default-route case. There is no address to go missing, so the poll
    // has no opinion and must never suspend on one.
    for (const bound of [undefined, '']) {
      const verdict = nicVerdict(bound, [], null, null);

      expect(verdict.suspend, `suspended with bound=${JSON.stringify(bound)}`).toBe(null);
      expect(verdict.nicBanner).toBe(null);
      expect(verdict.clearBanner).toBe(false);
    }
  });

  it('stays suspended, without re-clearing, across repeated absent ticks', () => {
    // The poll runs every 2 s and calls this with whatever the current answer
    // is. Two seconds of absence and ten minutes of it are the same verdict.
    const first = nicVerdict('10.200.50.78', [WIFI], null, null);
    const second = nicVerdict('10.200.50.78', [WIFI], first.nicBanner, first.nicBanner);

    expect(second.suspend).toContain('10.200.50.78');
    expect(second.nicBanner).toBe(GONE);
    expect(second.clearBanner).toBe(false);
  });

  it('clears exactly once when the NIC returns and stays', () => {
    // Cleared on the edge, then quiet. Re-publishing null every 2 s would
    // fight any error raised between ticks by the sender itself.
    const back = nicVerdict('10.200.50.78', [EN18], GONE, GONE);
    const still = nicVerdict('10.200.50.78', [EN18], back.nicBanner, null);

    expect(back.clearBanner).toBe(true);
    expect(still.clearBanner).toBe(false);
  });

  it('clears its own stale banner after the operator repins elsewhere', () => {
    // The operator gives up on the missing interface and pins a different one.
    // The banner still names the address that went away, but nothing is bound
    // to it any more and the sender is working, so it is obsolete — and it is
    // this poll's own message, so this poll is the thing that takes it down.
    const verdict = nicVerdict('192.168.1.40', [WIFI], GONE, GONE);

    expect(verdict.suspend, 'suspended over a NIC that is present').toBe(null);
    expect(verdict.clearBanner).toBe(true);
    expect(verdict.nicBanner).toBe(null);
  });
});
