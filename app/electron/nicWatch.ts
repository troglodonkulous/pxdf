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
 * banner outlived the fault forever. The edge is therefore owned here, above
 * any object that does not survive it. It is `wasGone && !gone` and nothing
 * else: a banner this poll did not raise belongs to the sender's own stderr,
 * and clearing that every 2 s would hide a real crash behind a healthy NIC.
 *
 * Graded by `app/test/nicWatch.test.ts`, whose docstring has the measurement.
 */
export function nicVerdict(
  bound: string | undefined,
  interfaces: readonly { name: string; address: string }[],
  wasGone: boolean,
): { suspend: string | null; clearBanner: boolean; gone: boolean } {
  const gone = bound !== undefined
    && bound.length > 0
    && !interfaces.some(({ address }) => address === bound)

  return {
    suspend: gone ? `floor NIC ${bound} is no longer assigned to any interface — check the cable` : null,
    clearBanner: wasGone && !gone,
    gone,
  }
}
