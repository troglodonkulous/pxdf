import { spawn, type ChildProcess } from 'node:child_process'

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
}

const RETRY_DELAYS_MS = [0, 250, 500, 1_000] as const

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

export class Sidecar {
  private child: ChildProcess | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private retryIndex = 0
  private lastFrame: Uint8Array | null = null
  private writable = false
  private started = false
  private stopping = false
  private stopPromise: Promise<void> | null = null

  constructor(private readonly options: SidecarOptions) {}

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

  private async shutDown(): Promise<void> {
    this.stopping = true
    this.started = false
    this.clearTimer('retryTimer')
    this.clearTimer('stableTimer')

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

  private clearTimer(which: 'retryTimer' | 'stableTimer'): void {
    const timer = this[which]
    if (timer !== null) {
      clearTimeout(timer)
      this[which] = null
    }
  }

  private spawnChild(): void {
    if (this.stopping || !this.started) return

    const address = process.env.DDF_ADDRESS ??
      (this.options.isPackaged ? '255.255.255.255' : '127.0.0.1')
    const port = process.env.DDF_PORT ?? String(60_001)
    const python = process.env.DDF_PYTHON ?? 'python3'
    const localIp = process.env.DDF_LOCAL_IP
    const args = [
      '-m', 'mapper', 'stream',
      '--type', this.options.type,
      '--cols', String(this.options.cols),
      '--rows', String(this.options.rows),
      '--fps', '30',
      '--address', address,
      '--port', port,
    ]
    if (localIp !== undefined && localIp.length > 0) {
      args.push('--local-ip', localIp)
    }

    const child = spawn(python, args, {
      cwd: this.options.repoRoot,
      stdio: ['pipe', 'ignore', 'inherit'],
    })
    this.child = child
    this.writable = false

    let failed = false
    const handleDeath = (): void => {
      if (failed) return
      failed = true
      this.clearTimer('stableTimer')

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

      if (this.child === child) {
        this.child = null
        this.writable = false
      }
      if (this.stopping || !this.started) return

      this.options.onStatus('stopped')
      this.scheduleRespawn()
    }

    child.on('error', handleDeath)
    child.once('exit', handleDeath)
    child.stdin?.on('error', handleDeath)
    child.stdin?.on('drain', () => {
      if (this.child === child && !failed) this.writable = true
    })
    child.once('spawn', () => {
      if (this.child !== child || failed) return

      this.writable = true
      this.writeIfPossible(this.lastFrame ?? this.options.blackFrame)
      this.options.onStatus('sending')

      // The ladder resets only once this child has *stayed* up. `spawn` fires
      // on process creation and says nothing about survival, so resetting here
      // would mean a sidecar that dies on startup every time — bad geometry, a
      // missing module, a port already held — respawns at the 0 ms rung
      // forever. Without the reset the ladder is instead a one-way ratchet: a
      // process that crashes once at load-in and recovers leaves it parked at
      // the 1 s hold, and an unrelated death hours later waits a second rather
      // than reconnecting at once. The interval is what separates the two.
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null
        if (this.child === child) this.retryIndex = 0
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
    this.options.onStatus('restarting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.spawnChild()
    }, delay)
  }
}
