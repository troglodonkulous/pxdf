import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The few things that should still be true after a quit.
 *
 * The app has held nothing across a launch until now, which was fine while
 * everything it knew could be re-chosen in a second. The floor NIC is not that:
 * picking the wrong one puts nothing on the wire and says nothing about it, and
 * the operator who has to re-pick it is doing so in a dark room at load-in with
 * a room full of people waiting. So it is stored.
 *
 * Deliberately not a store library and deliberately not a schema. One object,
 * one file, read once at launch. Fields arrive as the surfaces that need them
 * land — sidebar widths and the last media folder are the next two — and a
 * field nothing reads yet is a field that does not exist yet.
 */
export interface Settings {
  /** The address `mapper stream` binds to. Empty means the default route. */
  readonly localIp: string
}

const DEFAULTS: Settings = { localIp: '' }

/** Long enough to collapse a drag into one write, short enough to survive a quit. */
const WRITE_DEBOUNCE_MS = 500

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * Read what is on disk, or the defaults.
 *
 * **This must never throw.** A settings file is a convenience; a settings file
 * that stops the app from opening is a worse problem than the one it solves,
 * and the failure would land at the least recoverable moment — first launch on
 * a machine at a venue. Anything unreadable, unparseable or the wrong shape is
 * replaced by the default, out loud on stderr so it is diagnosable rather than
 * merely survivable.
 */
export function loadSettings(): Settings {
  let raw: string
  try {
    raw = readFileSync(settingsPath(), 'utf8')
  } catch {
    // No file yet is the normal first-launch case, not a fault.
    return DEFAULTS
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    const localIp = (parsed as Record<string, unknown>).localIp
    return { localIp: typeof localIp === 'string' ? localIp : DEFAULTS.localIp }
  } catch (error) {
    process.stderr.write(`settings.json is unreadable, using defaults: ${String(error)}\n`)
    return DEFAULTS
  }
}

let pending: Settings | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  writeTimer = null
  const next = pending
  pending = null
  if (next === null) return

  try {
    writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`)
  } catch (error) {
    // A read-only or full disk loses the preference, and nothing more. Saying
    // so beats a silent no-op that has the operator re-picking the same NIC
    // every launch with no idea why it will not stick.
    process.stderr.write(`could not write settings.json: ${String(error)}\n`)
  }
}

/** Queue a write. The last call inside the debounce window wins. */
export function saveSettings(next: Settings): void {
  pending = next
  if (writeTimer !== null) return
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS)
}

/**
 * Write anything still queued, now.
 *
 * Called from `before-quit`. Without it the debounce window is a hole exactly
 * where it matters most: change the NIC, quit inside half a second, and the
 * change is gone.
 */
export function flushSettings(): void {
  if (writeTimer !== null) clearTimeout(writeTimer)
  flush()
}
