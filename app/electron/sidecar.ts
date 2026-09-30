import { spawn, type ChildProcess } from 'node:child_process'
import { resolvePythonEnv } from './paths.js'
import { SEND_FPS } from '../src/render/framePacing.js'

/**
 * What the sender process is doing. Not what the floor is doing.
 *
 * These names used to be `linked` / `reconnecting` / `dropped`, and the first
 * of them was a claim nothing in this repo can support. It is published from
 * Node's `spawn` event, which — as the comment forty lines down has always said
 * — "fires on process creation and says nothing about survival", let alone
 * about a controller at the other end of a cable.
 *
 * Nor could any amount of work here make it support one. The child is spawned
 * with stdout `'ignore'`, so the sidecar has no back-channel; and `mapper` is
 * fire-and-forget UDP broadcast (`mapper/sender.py:38-40` opens `SOCK_DGRAM`
 * with `SO_BROADCAST` and never calls `recv`), so nothing downstream can
 * acknowledge even in principle. An operator reading "Linked" was reading a
 * statement about a Python process, dressed as one about the hardware.
 *
 * The bad news that *is* observable still arrives: `mapper/sender.py:44` binds
 * to the selected local IP, so an interface that has gone away makes the child
 * exit and lands here as `stopped`.
 */
export type SenderStatus = 'sending' | 'restarting' | 'stopped'

/**
 * Note what is *not* here: address, port, local IP and the Python binary.
 *
 * Each had an optional field beside its `DDF_*` environment override, and no
 * caller ever set one — not `main.ts`, not `sidecar.test.ts`, not the wire
 * gate, which seeds `DDF_ADDRESS` and `DDF_PORT`. Two ways to configure one
 * value, one of them dead, is a coin-flip for whoever next needs to change it,
 * and the dead half is the one that reads more discoverable. The environment
 * path stays because it is the one the gate actually exercises.
 */
export interface SidecarOptions {
  readonly isPackaged: boolean
  readonly repoRoot: string
  readonly type: string
  readonly cols: number
  readonly rows: number
  readonly blackFrame: Uint8Array
  readonly onStatus: (status: SenderStatus) => void
  readonly onError: (message: string | null) => void
  /**
   * Everything this supervisor did, for the log file.
   *
   * Optional and unused by most callers, which is why it is declared here
   * rather than joining `onError` in the `Omit` dance the constructor does: an
   * absent `onLog` is a silent supervisor, not a broken one.
   *
   * Distinct from `onError` on purpose. `onError` is the operator's channel and
   * carries one live sentence at a time; this is the historian's, and carries
   * everything including the parts that are not faults — which argv a child was
   * spawned with, what it said on stdout, how long the ladder waited. A crash
   * loop's *shape* is the diagnosis more often than any single death is, and
   * the shape only exists in a record that keeps the deaths that were
   * superseded.
   */
  readonly onLog?: (level: 'INFO' | 'ERROR', message: string) => void
}

const RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 5_000] as const

/**
 * How long a child must stay up before its spawn counts as a recovery.
 *
 * The ladder must not reset on the `spawn` event. Node emits that when the
 * process is *created*, not when it has survived anything — so a sidecar that
 * dies immediately every time (a bad geometry, a missing module, a busy socket)
 * would reset to the 0 ms rung on every attempt and respawn Python as fast as
 * the OS allows, forever. That is the tight crash loop the ladder exists to
 * prevent, reintroduced by the thing meant to fix it.
 */
const STABLE_AFTER_MS = 5_000

/** Wait this long past SIGKILL before giving up on ever seeing `exit`. */
const REAP_GRACE_MS = 2_000

/**
 * How long a child must stay up before the indicator says it is sending.
 *
 * Renaming the states was half a fix. `sending` was still published from the
 * `spawn` handler — the same instant `linked` used to be — and `spawn` fires on
 * process *creation*. A `mapper stream` that exits on its next tick, because the
 * geometry is illegal or `--local-ip` names an interface that has gone away, had
 * already been announced as sending. Worse, the retry ladder's first rung is
 * 0 ms, so a crash loop published `sending` on every attempt and the pill
 * strobed Sending / Stopped / Restarting several times a second while nothing
 * whatsoever was leaving the machine. A channel that does that is a channel the
 * operator stops reading, which is the failure the rename was for.
 *
 * So the promotion waits for the child to still be alive a beat later. Short
 * enough that a healthy launch reads Restarting for a blink rather than five
 * seconds — `STABLE_AFTER_MS` is far too long to put in front of an operator —
 * and long enough that an immediate exit never reaches `sending` at all.
 *
 * It still does not mean the floor is receiving. Nothing here can mean that.
 */
const SENDING_AFTER_MS = 400

const STDERR_LINE_LIMIT = 10

export class Sidecar {
  private readonly options: SidecarOptions
  private child: ChildProcess | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private sendingTimer: ReturnType<typeof setTimeout> | null = null
  private retryIndex = 0
  private lastFrame: Uint8Array | null = null
  private writable = false
  private started = false
  private stopping = false
  private suspended = false
  private stopPromise: Promise<void> | null = null
  /**
   * The last thing a child itself said about why it died — its stderr, or the
   * `Error` Node handed us — and nothing else. Held so that a later death which
   * says nothing at all can quote it *as history* rather than being reported
   * under it. Cleared wherever the banner is cleared, so it can never outlive
   * the failure it describes.
   */
  private lastReported: string | null = null

  constructor(options: SidecarOptions | Omit<SidecarOptions, 'onError'>) {
    this.options = 'onError' in options
      ? options
      : { ...options, onError: () => {} }
  }

  start(): void {
    if (this.started) return

    this.started = true
    this.stopping = false
    this.spawnChild()
  }

  writeFrame(frame: Uint8Array): void {
    // The wire format is headerless: frames are back to back with no length
    // prefix and no delimiter, so there is no point at which a reader can
    // resynchronise. One short or long write does not corrupt one frame, it
    // permanently offsets every frame after it. Anything that is not exactly
    // one framebuffer is dropped here rather than allowed past the boundary.
    if (!ArrayBuffer.isView(frame) || frame.byteLength !== this.options.blackFrame.byteLength) {
      return
    }

    this.lastFrame = frame
    this.writeIfPossible(frame)
  }

  stop(): Promise<void> {
    // One shared promise: a second caller must await the same shutdown rather
    // than returning immediately and letting the app quit out from under a
    // child that is still alive.
    this.stopPromise ??= this.shutDown()
    return this.stopPromise
  }

  suspend(reason: string): void {
    if (this.suspended) return

    // Mark suspended before signaling. Test doubles and some process wrappers
    // emit `exit` synchronously from `kill`; handleDeath must see this state or
    // it schedules the very respawn suspension exists to prevent.
    this.suspended = true
    this.clearTimer('retryTimer')
    this.clearTimer('stableTimer')
    this.clearTimer('sendingTimer')

    const child = this.child
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already reaped; suspension still owns the resulting stopped state.
      }
    }

    this.options.onStatus('stopped')
    this.options.onError(reason)
    this.options.onLog?.('INFO', `suspended: ${reason}`)
  }

  resume(): void {
    if (!this.suspended || this.stopping || !this.started) return

    this.suspended = false
    this.options.onLog?.('INFO', 'resumed: the bound address is back')
    // A missing NIC is not evidence that the sender itself is unhealthy. Once
    // the address exists again, retaining the crash ladder's old rung would
    // leave a recovered floor dark for up to five unnecessary seconds.
    this.retryIndex = 0
    this.clearError()
    this.spawnChild()
  }

  private async shutDown(): Promise<void> {
    this.options.onLog?.('INFO', 'stopping: black frame, then end stdin')
    this.stopping = true
    this.started = false
    this.clearTimer('retryTimer')
    this.clearTimer('stableTimer')
    this.clearTimer('sendingTimer')

    const child = this.child
    this.child = null
    this.writable = false
    if (child === null || child.exitCode !== null || child.signalCode !== null) return

    // Black before goodbye. Ending stdin makes the sidecar put its *last*
    // frame on the wire and exit, and controllers 2 and 3 then hold that frame
    // indefinitely — so quitting mid-show would leave the floor lit with
    // whatever was on it, with nothing left running to change it. Writing
    // black first makes the held frame black. It is written straight to the
    // pipe rather than through `writeIfPossible` because `end()` flushes it
    // even if backpressure has the slot marked unwritable.
    try {
      child.stdin?.write(this.options.blackFrame)
    } catch {
      // A pipe that is already gone needs no last frame.
    }

    await new Promise<void>((resolve) => {
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let reapTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (): void => {
        if (settled) return
        settled = true
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (reapTimer !== undefined) clearTimeout(reapTimer)
        resolve()
      }

      // Only `exit` resolves this. Resolving on the SIGKILL itself would let
      // the app quit while the child is still dying, which is how a sender
      // survives its parent and keeps broadcasting to a floor nobody is
      // driving any more.
      child.once('exit', finish)
      child.stdin?.end()

      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        reapTimer = setTimeout(finish, REAP_GRACE_MS)
      }, 2_000)
    })
  }

  /**
   * Take the banner down, and forget the cause with it.
   *
   * The two must move together. A `lastReported` left standing after the banner
   * is cleared would be quoted into the next silent death's message as though
   * the old fault were still live — the cry-wolf failure, arriving by a side
   * door.
   */
  private clearError(): void {
    this.lastReported = null
    this.options.onError(null)
  }

  /**
   * Say why a child died. Always — this publish has no guard on it.
   *
   * It used to have one: the message went out only if the child had written to
   * stderr. That is silent on exactly the deaths that print nothing. A `spawn
   * python3 ENOENT` (wrong venv, no Python on `PATH`) never creates a process,
   * so there is not one byte of stderr and the `Error` carrying ENOENT was
   * dropped into an ignored parameter; a signal kill and any silent nonzero
   * exit are the same shape. The operator got a pill cycling Stopped →
   * Restarting forever behind a blank banner, which is a floor that is down
   * with nothing on screen saying so.
   *
   * Precedence is the child's own words first: stderr, then the `Error` Node
   * raised, then a sentence synthesised from the exit status. The synthesised
   * case also carries the last thing a child *did* report, explicitly labelled
   * as prior — a crash loop whose first child explained itself and whose later
   * children die mute must not lose that explanation, and must not have the
   * later deaths reported under it either.
   */
  private publishDeath(stderr: string, cause: Error | null, code: number | null, signal: string | null): void {
    // Logged before the branch, and carrying the raw status rather than the
    // sentence below it. The synthesised sentence deliberately loses
    // information — a death that explained itself on stderr never mentions its
    // exit code at all — and the exit code is the diagnosis for `mapper`'s
    // stream path specifically, which exits with distinct codes precisely so
    // "a human reading a log" can tell a dead NIC from a crash. Until now there
    // was no log for it to preserve the diagnosis in.
    this.options.onLog?.(
      'ERROR',
      `child died: code=${code ?? '-'} signal=${signal ?? '-'}` +
      (cause === null ? '' : ` error=${cause.message}`),
    )

    const reported = stderr.length > 0 ? stderr : (cause?.message ?? '')
    if (reported.length > 0) {
      this.lastReported = reported
      this.options.onError(reported)
      return
    }

    const synthesised = signal !== null
      ? `sender killed by ${signal}`
      : code !== null
        ? `sender exited with code ${code}`
        : 'sender exited'
    this.options.onError(
      this.lastReported === null
        ? synthesised
        : `${synthesised}; last reported: ${this.lastReported}`,
    )
  }

  private clearTimer(which: 'retryTimer' | 'stableTimer' | 'sendingTimer'): void {
    const timer = this[which]
    if (timer !== null) {
      clearTimeout(timer)
      this[which] = null
    }
  }

  private spawnChild(): void {
    // `this.suspended` here is a backstop, and mutation-checked as one: removing
    // it alone leaves every test green, because `suspend` clears the pending
    // retry timer and `handleDeath` returns before scheduling a new one, so
    // nothing reaches this line while suspended today. Removing all of them
    // together does go red. It stays because this is the single funnel every
    // spawn passes through — first launch, ladder respawn, and `main.ts`
    // replacing the instance — and a future path that reaches it would
    // otherwise put a sender on a floor the operator has been told is down.
    if (this.stopping || !this.started || this.suspended) return

    // Every path that brings a child up passes through here — first launch, a
    // ladder respawn, and `main.ts` replacing the whole instance for a floor or
    // NIC change. That last one is why this belongs here rather than in
    // `scheduleRespawn`: `stop()` publishes nothing, so a replacement used to
    // leave the previous child's status standing until the new one announced
    // itself. That was survivable while the announcement came from `spawn`;
    // once it waits for `SENDING_AFTER_MS` it is a 400 ms window in which the
    // indicator reads Sending on behalf of a process that has already been
    // killed. Saying `restarting` the moment a child is being brought up closes
    // it, and is true on all three paths.
    this.options.onStatus('restarting')

    const address = process.env.DDF_ADDRESS ??
      (this.options.isPackaged ? '255.255.255.255' : '127.0.0.1')
    const port = process.env.DDF_PORT ?? String(60_001)
    const python = process.env.DDF_PYTHON ?? 'python3'
    const localIp = process.env.DDF_LOCAL_IP
    // Opt-in only (D-02). Unset leaves `mapper`'s own default, `clock`, in
    // charge. `--emit-timing` is never passed: every stdout line is logged at
    // INFO below, and it prints one per frame.
    const pacing = process.env.DDF_STREAM_PACING
    const args = [
      '-m', 'mapper', 'stream',
      '--type', this.options.type,
      '--cols', String(this.options.cols),
      '--rows', String(this.options.rows),
      '--fps', String(SEND_FPS),
      '--address', address,
      '--port', port,
    ]
    if (localIp !== undefined && localIp.length > 0) {
      args.push('--local-ip', localIp)
    }
    if (pacing !== undefined && pacing.length > 0) {
      args.push('--pacing', pacing)
    }

    // The command, in full, every time.
    //
    // Reconstructing it from the UI is guesswork — `--local-ip` is present or
    // absent depending on an environment variable set from a persisted
    // setting, and `--address` differs between packaged and dev builds. When a
    // sender is on the wrong NIC or broadcasting to the wrong address, this
    // line is the difference between reading the answer and inferring it.
    this.options.onLog?.('INFO', `spawning: ${python} ${args.join(' ')}`)

    const child = spawn(python, args, {
      cwd: this.options.repoRoot,
      // `PYTHONUNBUFFERED` is not hygiene, it is the difference between the
      // stdout capture below working and silently capturing nothing.
      //
      // MEASURED 2026-09-03, first run of this change: the log recorded the
      // spawn and every status transition, and not one line of `mapper`'s own
      // output. Python block-buffers stdout when it is a pipe rather than a
      // TTY, and `cmd_stream`'s opening prints — the geometry, and
      // `sending to <address>:<port> at <fps> fps from <nic>` — carry no
      // `flush=True`. They sat in the child's buffer for the life of the
      // process, so a capture that looked like it was working was recording a
      // stream that never arrived.
      //
      // Fixed here rather than in `mapper/cli.py` because, when this was
      // written, nothing in `mapper/` could change for the app (now scoped by
      // D-01/D-02 in docs/DECISIONS.md). The cost is nil: that path prints
      // three lines at startup and none per frame.
      env: { ...resolvePythonEnv(this.options.isPackaged), PYTHONUNBUFFERED: '1' },
      // stdout was `'ignore'`, which discarded the only unsolicited statement
      // `mapper stream` makes about what it is actually doing:
      //
      //     sending to 255.255.255.255:60001 at 30 fps from 10.200.50.78
      //
      // That is the sender naming its own address, port, rate and bound NIC —
      // the four things an operator debugging a dark floor most wants
      // confirmed, and the four this app otherwise can only report its
      // *intent* about. A piped stream must be drained or the child blocks once
      // the pipe buffer fills, so the `data` handler below is load-bearing and
      // not merely useful.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.writable = false

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.options.onLog?.('INFO', `stdout: ${line}`)
      }
    })

    let stderrLines: string[] = []
    let stderrRemainder = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // Capturing stderr gives the renderer a useful failure reason, but it
      // must not take the terminal copy away from developers diagnosing a
      // machine where the UI itself may be unavailable.
      process.stderr.write(chunk)

      const lines = `${stderrRemainder}${chunk}`.split(/\r?\n/)
      stderrRemainder = lines.pop() ?? ''

      // Uncapped, unlike the banner copy below. `STDERR_LINE_LIMIT` exists so a
      // banner stays a sentence rather than a wall, which is right for the
      // screen and wrong for the record: a Python traceback is mostly frames,
      // and the frame that names the failing call is as likely to be the
      // eleventh from the end as the first.
      for (const line of lines) {
        if (line.trim().length > 0) this.options.onLog?.('ERROR', `stderr: ${line}`)
      }

      stderrLines.push(...lines)
      if (stderrLines.length > STDERR_LINE_LIMIT) {
        stderrLines = stderrLines.slice(-STDERR_LINE_LIMIT)
      }
    })

    let failed = false
    const handleDeath = (cause: Error | null, code: number | null, signal: string | null): void => {
      if (failed) return
      failed = true
      this.clearTimer('stableTimer')
      this.clearTimer('sendingTimer')

      const wasCurrent = this.child === child

      // Make sure this child is really gone before another is started. The
      // trigger may be a stdin error rather than an exit — a broken pipe on a
      // process that is still running — and spawning a replacement beside a
      // live one puts two senders on the same broadcast address, interleaving
      // two frame streams onto one floor.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already reaped; nothing to do.
        }
      }

      if (wasCurrent) {
        this.child = null
        this.writable = false
      }
      // A suspended child may finish dying after resume has already installed
      // its replacement. Its late exit belongs to the detached process, not
      // the healthy current one, and must not start another sender beside it.
      if (!wasCurrent || this.stopping || !this.started || this.suspended) return

      const stderr = (stderrRemainder.length > 0 ? [...stderrLines, stderrRemainder] : stderrLines)
        .slice(-STDERR_LINE_LIMIT)
        .join('\n')
        .trimEnd()
      this.publishDeath(stderr.trim().length > 0 ? stderr : '', cause, code, signal)

      this.options.onStatus('stopped')
      this.scheduleRespawn()
    }

    // Wrappers, not a bare `handleDeath` on each of these. `exit` emits
    // `(code, signal)`, so the moment `handleDeath` takes a cause as its first
    // parameter a bare reference binds the exit code to it — a number, whose
    // `.message` is `undefined`. The publish would then fall through to a
    // synthesised sentence with no code and no signal on the commonest death
    // there is, while the diff still read like a fix.
    child.on('error', (cause: Error) => handleDeath(cause, null, null))
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      handleDeath(null, code, signal)
    })
    child.stdin?.on('error', (cause: Error) => handleDeath(cause, null, null))
    child.stdin?.on('drain', () => {
      if (this.child === child && !failed) this.writable = true
    })
    child.once('spawn', () => {
      if (this.child !== child || failed) return

      this.writable = true
      this.writeIfPossible(this.lastFrame ?? this.options.blackFrame)

      // Not `onStatus('sending')` here. See `SENDING_AFTER_MS`: this line is
      // where the old `linked` was published, and publishing `sending` from the
      // same event would have been the same claim in a smaller word.
      this.sendingTimer = setTimeout(() => {
        this.sendingTimer = null
        if (this.child === child && !failed) this.options.onStatus('sending')
      }, SENDING_AFTER_MS)

      // The ladder resets only once this child has *stayed* up. `spawn` fires
      // on process creation and says nothing about survival, so resetting here
      // would mean a sidecar that dies on startup every time — bad geometry, a
      // missing module, a port already held — respawns at the 0 ms rung
      // forever. Without the reset the ladder is instead a one-way ratchet: a
      // process that crashes once at load-in and recovers leaves it parked at
      // the 5 s hold, and an unrelated death hours later waits five seconds
      // rather than reconnecting at once. The interval separates the two.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null
        if (this.child === child && !failed) {
          this.retryIndex = 0
          // Logged because `clearError` is where the operator's evidence
          // disappears: the banner describing the death comes down here, five
          // seconds after a healthy child started. Before this file had a log,
          // a sender that crashed and recovered during load-in left no trace of
          // having crashed at all — the fault, and the fact that it resolved,
          // were the same absence.
          this.options.onLog?.('INFO', `stable for ${STABLE_AFTER_MS}ms; retry ladder reset, banner cleared`)
          this.clearError()
        }
      }, STABLE_AFTER_MS)
    })
  }

  private writeIfPossible(frame: Uint8Array): void {
    const child = this.child
    if (!this.writable || child?.stdin === null || child === null) return

    if (!child.stdin.write(frame)) this.writable = false
  }

  private scheduleRespawn(): void {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)]
    this.retryIndex += 1
    // The ladder rung, which is how a crash loop identifies itself in the log.
    // A sender that failed once and recovered logs a single 0 ms respawn; one
    // that cannot start at all walks 0/250/500/1000/2000/5000 and then repeats
    // 5000 for ever. Those are different faults and they read differently here.
    this.options.onLog?.('INFO', `respawning in ${delay}ms (attempt ${this.retryIndex})`)
    // `restarting` is published by `spawnChild`, not here. During this delay —
    // up to five seconds at the top of the ladder — nothing is coming up yet, and
    // `stopped` is the accurate word for that.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.spawnChild()
    }, delay)
  }
}
