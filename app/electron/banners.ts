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
 * more than one slot is live the most urgent wins and the rest are counted, so
 * a second fault is never *invisible* even when it is not the one shown; the
 * log has every one of them in full, with its source and timestamp.
 */

export type BannerSource = 'log' | 'fatal' | 'sender' | 'nic' | 'watchdog'

/**
 * Most urgent first — ordered by how much of the app the reader should distrust
 * once it fires, not by how loud the failure was.
 *
 * `log` leads despite never being about the show, because it is the one fault
 * that changes how everything below it should be read: with no file, the "+N
 * more" the operator is being asked to trust is not recoverable anywhere. It is
 * also published once, at launch, and cannot recur.
 *
 * `fatal` next: a main process that threw is in an unknown state, so every
 * other slot's silence is now worth less.
 */
const PRIORITY: readonly BannerSource[] = ['log', 'fatal', 'sender', 'nic', 'watchdog']

/**
 * The live slots as one line for the renderer, or null when nothing is wrong.
 *
 * Identical messages from two sources collapse to one: the NIC poll suspends
 * the sidecar with its own reason, and the sidecar reports that same reason
 * through its error channel, so the cable-out case legitimately fills two slots
 * with one sentence and must not read as two faults.
 */
export function composeBanner(
  live: Readonly<Partial<Record<BannerSource, string | null>>>,
): string | null {
  const messages = PRIORITY
    .map((source) => live[source] ?? null)
    .filter((message): message is string => message !== null)
  const [first, ...rest] = [...new Set(messages)]

  if (first === undefined) return null
  return rest.length === 0 ? first : `${first} (+${rest.length} more)`
}
