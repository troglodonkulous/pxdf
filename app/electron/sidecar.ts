import { spawn, type ChildProcess } from 'node:child_process'

export type LinkStatus = 'linked' | 'reconnecting' | 'dropped'

export interface SidecarOptions {
  readonly isPackaged: boolean
  readonly repoRoot: string
  readonly type: string
  readonly cols: number
  readonly rows: number
  readonly blackFrame: Uint8Array
  readonly onStatus: (status: LinkStatus) => void
  readonly address?: string
  readonly port?: number
  readonly localIp?: string
  readonly python?: string
}

const RETRY_DELAYS_MS = [0, 250, 500, 1_000] as const

export class Sidecar {
  private child: ChildProcess | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryIndex = 0
  private lastFrame: Uint8Array | null = null
  private writable = false
  private started = false
  private stopping = false

  constructor(private readonly options: SidecarOptions) {}

  start(): void {
    if (this.started) return

    this.started = true
    this.stopping = false
    this.spawnChild()
  }

  writeFrame(frame: Uint8Array): void {
    this.lastFrame = frame
    this.writeIfPossible(frame)
  }

  async stop(): Promise<void> {
    if (this.stopping) return

    this.stopping = true
    this.started = false

    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    const child = this.child
    this.child = null
    this.writable = false
    if (child === null || child.exitCode !== null || child.signalCode !== null) return

    await new Promise<void>((resolve) => {
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      const finish = (): void => {
        if (settled) return
        settled = true
        if (killTimer !== undefined) clearTimeout(killTimer)
        resolve()
      }

      child.once('exit', finish)
      child.stdin?.end()

      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        finish()
      }, 2_000)
    })
  }

  private spawnChild(): void {
    if (this.stopping || !this.started) return

    const address = process.env.DDF_ADDRESS ?? this.options.address ??
      (this.options.isPackaged ? '255.255.255.255' : '127.0.0.1')
    const port = process.env.DDF_PORT ?? String(this.options.port ?? 60_001)
    const python = process.env.DDF_PYTHON ?? this.options.python ?? 'python3'
    const localIp = process.env.DDF_LOCAL_IP ?? this.options.localIp
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
      if (this.child === child) {
        this.child = null
        this.writable = false
      }
      if (this.stopping || !this.started) return

      this.options.onStatus('dropped')
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

      // Reset the ladder on a spawn that survived. Without this the backoff is
      // a one-way ratchet: a sidecar that dies once at load-in and recovers
      // leaves `retryIndex` parked at the 1 s hold, so a second, unrelated
      // death hours later waits a second before respawning instead of
      // reconnecting immediately. The ladder exists to stop a *tight* crash
      // loop, not to penalise a process for having crashed before.
      this.retryIndex = 0
      this.writable = true
      this.writeIfPossible(this.lastFrame ?? this.options.blackFrame)
      this.options.onStatus('linked')
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
    this.options.onStatus('reconnecting')
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.spawnChild()
    }, delay)
  }
}
