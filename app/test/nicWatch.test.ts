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
 * will ever take it down. That is both halves of what this branch exists to
 * remove at once — a display that disagrees with the binding, and a channel
 * that cries wolf until the operator stops reading it.
 *
 * The fix is that the verdict is level-triggered and owned here rather than
 * inferred from a transition on an object that does not outlive the fault.
 * `nicVerdict` is pure so it can be graded without `node:os`, an Electron, or
 * a live NIC; `main.ts` holds the one `gone` flag it threads through.
 */
describe('nicVerdict', () => {
  const EN18 = { name: 'en18', address: '10.200.50.78' };
  const WIFI = { name: 'en0', address: '192.168.1.40' };

  it('suspends, naming the address, while the bound NIC is absent', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI], false);

    expect(verdict.suspend).toContain('10.200.50.78');
    expect(verdict.gone).toBe(true);
  });

  it('resumes once the bound NIC is back', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], true);

    expect(verdict.suspend).toBe(null);
    expect(verdict.gone).toBe(false);
  });

  /**
   * The regression the review found. `resume()` on a replacement sidecar is a
   * no-op, so the instruction to take the banner down cannot be carried by it.
   */
  it('clears the banner itself when the NIC returns, not via resume', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], true);

    expect(verdict.clearBanner, 'left an error banner up over a working sender').toBe(true);
  });

  /**
   * The other half of that. A banner this poll did not raise is not this
   * poll's to take down — `Sidecar` publishes the sender's own stderr through
   * the same channel, and a crash-loop message cleared once a second by a
   * healthy NIC check is a defect reported and then hidden.
   */
  it('does not clear a banner it never raised', () => {
    const verdict = nicVerdict('10.200.50.78', [WIFI, EN18], false);

    expect(verdict.suspend).toBe(null);
    expect(verdict.clearBanner, 'stomped an error from another source').toBe(false);
  });

  it('leaves the sender alone when no NIC is pinned', () => {
    // The default-route case. There is no address to go missing, so the poll
    // has no opinion and must never suspend on one.
    for (const bound of [undefined, '']) {
      const verdict = nicVerdict(bound, [], false);

      expect(verdict.suspend, `suspended with bound=${JSON.stringify(bound)}`).toBe(null);
      expect(verdict.gone).toBe(false);
      expect(verdict.clearBanner).toBe(false);
    }
  });

  it('stays suspended, without re-clearing, across repeated absent ticks', () => {
    // The poll runs every 2 s and calls this with whatever the current answer
    // is. Two seconds of absence and ten minutes of it are the same verdict.
    const first = nicVerdict('10.200.50.78', [WIFI], false);
    const second = nicVerdict('10.200.50.78', [WIFI], first.gone);

    expect(second.suspend).toContain('10.200.50.78');
    expect(second.gone).toBe(true);
    expect(second.clearBanner).toBe(false);
  });

  it('clears exactly once when the NIC returns and stays', () => {
    // Cleared on the edge, then quiet. Re-publishing null every 2 s would
    // fight any error raised between ticks by the sender itself.
    const back = nicVerdict('10.200.50.78', [EN18], true);
    const still = nicVerdict('10.200.50.78', [EN18], back.gone);

    expect(back.clearBanner).toBe(true);
    expect(still.clearBanner).toBe(false);
  });
});
