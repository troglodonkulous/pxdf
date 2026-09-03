/**
 * One banner slot, five things that can fill it.
 *
 * ## The defect this replaces
 *
 * `main.ts` published errors into a single `currentSenderError`, written by
 * five independent sources: a main-process throw, a log file that could not be
 * opened, the sidecar, the NIC poll, and the frame watchdog. Each source
 * remembered the message it had published so that it would only clear its own —
 * the guard `nicWatch.ts` was written for — but nothing stopped one source
 * *overwriting* another's message, and after that overwrite the loser's private
 * memory was stale.
 *
 * Two failures came out of that, and both cost exactly the diagnostics this
 * branch exists to produce:
 *
 *   - **Lost.** `Sidecar` clears its own banner on every recovery, and the
 *     retry ladder makes recovery routine. The startup warning "no log file
 *     this session" was published before the sidecar's first spawn, so the
 *     first successful respawn wiped it — the one notice that the evidence
 *     chain for the whole session was broken, gone inside five seconds, with
 *     nowhere to write it down because the thing it was reporting was the log.
 *
 *   - **Stranded.** The watchdog publishes on the edge: it compares the message
 *     it wants to show against the one it last published and stays quiet if
 *     they match. Let a sidecar death overwrite the frozen-renderer banner and
 *     the watchdog's own memory still holds that message, so the comparison
 *     keeps matching and it never speaks again. The floor stays frozen and its
 *     only channel has silently gone out of service for the rest of the run.
 *
 * ## The shape of the fix
 *
 * A source may only write its own slot. Nothing else can reach it, so no source
 * can lose another's message and no source's memory of what it published can go
 * stale behind its back — the per-watcher ownership guards become structurally
 * true rather than separately enforced.
 *
 * The renderer still gets one string, because the UI has one line for it. When
 * more than one slot is live the most actionable wins and the rest are counted,
 * so a second fault is never *invisible* even when it is not the one shown; the
 * log has every one of them in full, with its source and timestamp — and where
 * there is no log, `composeBanner` carries their text instead of a count.
 */

export type BannerSource = 'log' | 'fatal' | 'sender' | 'nic' | 'watchdog'

/**
 * Ordered by what the operator can do about it *now*, most actionable first.
 *
 * The obvious ordering — by severity, or by how much of the app the reader
 * should distrust — is wrong here, and wrong in a way that costs exactly what
 * this file was added to protect. `log` and `fatal` are the only two slots
 * nothing ever clears: the log directory does not become writable mid-show, and
 * a main process that threw stays thrown. Rank a permanent fault above the
 * transient ones and it sits on the banner for the rest of the session, and
 * every dark floor, unplugged cable and frozen renderer after it is demoted to
 * a number — the failure this file exists to prevent, re-created by its own
 * ranking.
 *
 * So the two sticky slots rank below the three that describe something the
 * operator is standing next to and can fix. Neither is hidden by that: see
 * `composeBanner` for what happens to the ones that are not shown.
 */
const PRIORITY: readonly BannerSource[] = ['sender', 'nic', 'watchdog', 'fatal', 'log']

/**
 * The live slots as one line for the renderer, or null when nothing is wrong.
 *
 * Identical messages from two sources collapse to one: the NIC poll suspends
 * the sidecar with its own reason, and the sidecar reports that same reason
 * through its error channel, so the cable-out case legitimately fills two slots
 * with one sentence and must not read as two faults.
 *
 * `(+2 more)` is a pointer at the log, and is only honest while there is a log
 * to point at. When the `log` slot is live there is no file and the banner is
 * the only surviving record of the session, so the messages it cannot lead with
 * are carried in full rather than counted. That is the one case where a longer
 * banner is the correct trade: the alternative is a number standing in for
 * faults that are, at that moment, recorded nowhere at all.
 */
export function composeBanner(
  live: Readonly<Partial<Record<BannerSource, string | null>>>,
): string | null {
  const messages = PRIORITY
    .map((source) => live[source] ?? null)
    .filter((message): message is string => message !== null)
  const unique = [...new Set(messages)]
  const [first, ...rest] = unique

  if (first === undefined) return null
  if (rest.length === 0) return first
  return (live.log ?? null) !== null ? unique.join(' · ') : `${first} (+${rest.length} more)`
}
