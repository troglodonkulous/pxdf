/**
 * The one place a failure can be read after the fact.
 *
 * Everything this app knew about a fault used to end in a React banner. A
 * banner is overwritten by the next event, erased by a restart, and invisible
 * to anyone who was not looking at the screen in the second it appeared — so
 * the last job's playback problems produced no evidence at all, and the
 * decision was made to run the older build rather than diagnose the newer one.
 *
 * This file does not replace any of those banners. It tees them somewhere that
 * survives, so a floor session produces a record instead of an anecdote.
 *
 * ## Why `appendFileSync` and not a write stream
 *
 * A `WriteStream` buffers, and the buffer is lost when the process dies. On a
 * crash the tail is the only part anyone wants — the lines immediately before
 * the end are the ones describing the thing that ended it. A stream optimises
 * the case nobody is debugging and loses the case everybody is.
 *
 * The cost is a synchronous write on the main process's thread, and it is
 * affordable because of what calls this: status transitions, error publishes, a
 * heartbeat once a minute, and sidecar output. It is never called per frame,
 * and `main.ts`'s `ddf:frame` handler must not start.
 *
 * ## What this does when it is broken
 *
 * A read-only log directory, a full disk, a path the sandbox refuses — the
 * write throws, and a logger that swallowed that would be the exact defect this
 * whole change exists to remove: a channel that reads as healthy while carrying
 * nothing. So a failed write goes to `process.stderr` and is remembered in
 * `writeError`, which `main.ts` reads after the launch block and turns into an
 * operator-visible banner. The app still starts — refusing to run because it
 * cannot log would be a worse trade on a show night — but nobody is told the
 * log is fine when it is not.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export interface Logger {
  /** Absolute path of the file being written, for the reveal control and the launch block. */
  readonly path: string
  log(level: LogLevel, source: string, message: string): void
  /**
   * Why the last write failed, or null.
   *
   * Sticky rather than a callback: the read happens once, right after launch,
   * and a callback would need the caller to be ready before the first line is
   * written — which it cannot be, because the first line is what reports the
   * environment the caller is being set up in.
   */
  readonly writeError: string | null
}

/**
 * Continuation-line indent for a multi-line message.
 *
 * Every record starts with an ISO-8601 instant, so it starts with a digit. A
 * leading space therefore marks a line as belonging to the record above it with
 * no ambiguity and no escaping — `grep '^2026-09-03T14'` still returns one line
 * per event, and a Python traceback pasted in whole stays readable.
 */
const CONTINUATION = '    '

export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true })

  const path = join(dir, 'ddf.log')

  // One rotation, at construction, and no size check.
  //
  // The unit that matters here is the *run*, not the megabyte: when something
  // goes wrong at a venue the operator restarts the app, and the interesting
  // file is the one from the launch before this one. Rotating by size would
  // routinely throw that away mid-session, and rotating by count would need a
  // policy nobody has asked for. `renameSync` replaces an existing target on
  // POSIX, so there are exactly two files, for ever.
  //
  // Wrapped because a rotation that fails must not stop the app from logging
  // the run it is starting; appending to the old file is strictly better than
  // not starting.
  try {
    if (existsSync(path)) renameSync(path, join(dir, 'ddf.prev.log'))
  } catch {
    // Keep going, and append. The next write reports any real problem.
  }

  let writeError: string | null = null

  return {
    path,
    get writeError() {
      return writeError
    },
    log(level, source, message) {
      const [first = '', ...rest] = message.split('\n')
      const head = `${new Date().toISOString()}  ${level.padEnd(5)}  ${source}  ${first}`
      const body = rest.map((line) => `${CONTINUATION}${line}`)
      const record = `${[head, ...body].join('\n')}\n`

      try {
        appendFileSync(path, record)
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error)
        // The one place in this file that writes somewhere else, and the reason
        // it is not silent: under `npm run dev` this is a real terminal, and it
        // is the only channel left once the intended one has failed.
        process.stderr.write(`ddf: could not write to ${path}: ${writeError}\n${record}`)
      }
    },
  }
}
