/**
 * Is the pinned floor NIC present, and what should that change?
 *
 * Level-triggered on purpose. `main.ts` polls every 2 s and passes whatever
 * the current answer is, so absence for one tick and absence for ten minutes
 * produce the same verdict, and a tick dropped under load costs 2 s rather
 * than a lost transition.
 *
 * `clearBanner` is the exception, and the reason this function exists rather
 * than the two `if` branches it replaced. Taking the error banner down used to
 * be a side effect of `Sidecar.resume()`, which returns early unless that same
 * instance is suspended — and `doSetFloor` replaces the instance wholesale, so
 * a sidecar built while the cable was out could never be resumed and the
 * banner outlived the fault forever. The poll therefore owns the one message
 * it published, above any object that does not survive the fault, and clears
 * only while that exact message is still the one on screen. If another fault
 * replaced it, recovery forgets the poll's stale message without touching the
 * replacement.
 *
 * Graded by `app/test/nicWatch.test.ts`, whose docstring has the measurement.
 */
export function nicVerdict(
  bound: string | undefined,
  interfaces: readonly { name: string; address: string }[],
  lastNicBanner: string | null,
  currentBanner: string | null,
): { suspend: string | null; clearBanner: boolean; nicBanner: string | null } {
  const gone = bound !== undefined
    && bound.length > 0
    && !interfaces.some(({ address }) => address === bound)
  const suspend = gone
    ? `floor NIC ${bound} is no longer assigned to any interface — check the cable`
    : null

  return {
    suspend,
    clearBanner: lastNicBanner !== null && currentBanner === lastNicBanner && !gone,
    nicBanner: suspend,
  }
}
