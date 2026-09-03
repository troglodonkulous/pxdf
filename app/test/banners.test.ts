import { describe, expect, it } from 'vitest';

import { composeBanner } from '../electron/banners';

/**
 * The banner slot, and the two ways one channel with five writers ate the
 * diagnostics this branch was built to produce.
 *
 * MEASURED by review 2026-09-03, on this branch, before it was merged. Every
 * source published into a single `currentSenderError` and separately remembered
 * what it had put there so it would clear only its own message. That guard is
 * sound against a *clear* by another source and useless against a *write* by
 * one:
 *
 *   1. `main.ts` warns at launch that the log directory could not be created.
 *   2. The sidecar spawns, fails, retries, and succeeds — routine, and the
 *      ladder makes it likely inside the first few seconds.
 *   3. `Sidecar.clearError()` publishes null on that recovery.
 *
 * The warning that the session has no evidence chain is gone, and there is no
 * log to have recorded it, because that was the fault.
 *
 * The second is worse because it is silent. The watchdog publishes on the edge,
 * comparing its wanted message against the one it last published. Overwrite its
 * banner with a sidecar death and its memory still holds the old string, the
 * comparison keeps matching, and the frozen-floor channel is out of service for
 * the rest of the run with nothing to show that it is.
 *
 * Per-source slots make both impossible: no source can write another's, so no
 * source's memory can go stale behind its back. These tests grade the one thing
 * left that is not structural — which message a shared, one-line UI shows when
 * several are live, and that the others are still counted rather than dropped.
 *
 * SECOND DEFECT, found by review of that fix the same day. The first cut ranked
 * `log` first, reasoning that a session with no evidence chain changes how every
 * other message should be read. It does — but `log` and `fatal` are the only two
 * slots nothing ever clears, so ranking either above the transient faults parks
 * a permanent, unactionable sentence on the banner and demotes every dark floor,
 * unplugged cable and frozen renderer after it to `(+1 more)`. In the one
 * situation where there is no log to expand that number from. The fix that hid
 * diagnostics, by its own ranking.
 *
 * So the sticky slots rank last, and `(+N more)` — which is a pointer at the log
 * — is only used while there is a log to point at.
 *
 * MUTATION-CHECKED 2026-09-03: dropping the `new Set` de-duplication makes
 * "counts one fault once" red; returning `first` unconditionally instead of
 * appending the count makes "says how many it is not showing" red; moving `log`
 * back to the front of `PRIORITY` makes "leads with the fault the operator can
 * act on" red; using the count regardless of the log makes "spells the others
 * out when there is no log to expand a count from" red.
 */
describe('composeBanner', () => {
  const FROZEN = 'the renderer has stopped producing frames — the floor is holding its last picture';
  const DIED = 'sender exited with code 3';
  const NO_LOG = 'no log file this session — the log folder could not be created';
  const CABLE = 'floor NIC 10.200.50.78 is no longer assigned to any interface — check the cable';

  it('says nothing when every slot is empty', () => {
    expect(composeBanner({})).toBeNull();
    expect(composeBanner({ sender: null, watchdog: null })).toBeNull();
  });

  it('shows the only live fault, unadorned', () => {
    expect(composeBanner({ watchdog: FROZEN })).toBe(FROZEN);
  });

  it('keeps a lower-priority fault alive under a higher one', () => {
    // The stranding case, stated as the property that prevents it. The
    // watchdog's message survives a sidecar death in its own slot, so when the
    // sender recovers the frozen floor is reported again — under the old shared
    // slot it was overwritten and never spoke a second time.
    const both = { sender: DIED, watchdog: FROZEN };

    expect(composeBanner(both)).toContain(DIED);
    expect(composeBanner({ ...both, sender: null })).toBe(FROZEN);
  });

  it('says how many faults it is not showing', () => {
    expect(composeBanner({ sender: DIED, watchdog: FROZEN })).toBe(`${DIED} (+1 more)`);
  });

  it('leads with the fault the operator can act on, not the one that is permanent', () => {
    // Nothing clears `log` or `fatal` — the log directory does not become
    // writable mid-show, and a main process that threw stays thrown. Ranked
    // above the transient faults, either one would occupy the banner for the
    // rest of the session and reduce every dark floor after it to a number.
    expect(composeBanner({ log: NO_LOG, sender: DIED })?.startsWith(DIED)).toBe(true);
    expect(
      composeBanner({ fatal: 'the app hit an internal error', sender: DIED })?.startsWith(DIED),
    ).toBe(true);
  });

  it('still says the log is gone, under the fault it is standing behind', () => {
    // Demoted, never dropped. The operator needs the actionable sentence first
    // and still has to know that nothing is being written down.
    expect(composeBanner({ log: NO_LOG, sender: DIED })).toContain(NO_LOG);
  });

  it('spells the others out when there is no log to expand a count from', () => {
    // `(+N more)` is a pointer at the log file. With no file it points at
    // nothing, and the banner is the only surviving record of the session — so
    // it carries the messages rather than the number.
    const composed = composeBanner({ log: NO_LOG, sender: DIED, watchdog: FROZEN });

    expect(composed).toBe(`${DIED} · ${FROZEN} · ${NO_LOG}`);
    expect(composed, 'counted faults that are recorded nowhere else').not.toContain('more)');
  });

  it('ranks a main-process throw below the sender it supervises', () => {
    // `fatal` is a bug report; a sender that has stopped is a floor with
    // nothing driving it, and one of the two has something to do about it now.
    const fatal = 'the app hit an internal error — see the log';

    expect(composeBanner({ fatal, sender: DIED, nic: CABLE })).toBe(`${DIED} (+2 more)`);
  });

  it('counts one fault once when two sources report it', () => {
    // The cable-out path fills two slots with one sentence: the NIC poll
    // suspends the sidecar with this reason, and the sidecar publishes the
    // reason it was suspended with. One fault, one line, no phantom count.
    expect(composeBanner({ nic: CABLE, sender: CABLE })).toBe(CABLE);
  });
});
