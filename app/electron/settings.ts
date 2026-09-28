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
 * land — sidebar widths are the next one — and a field nothing reads yet is a
 * field that does not exist yet.
 */
export interface Settings {
  /** The address `mapper stream` binds to. Empty means the default route. */
  readonly localIp: string
  /**
   * The folder the picker last opened a file from.
   *
   * Read by the Cue Library section to repopulate on launch — see the long
   * comment beside `authorizedMediaDir` in `main.ts` for what re-authorising
   * this folder after a restart does and does not hand the renderer. Empty
   * means nothing has ever been picked.
   */
  readonly lastMediaDir: string
}

const DEFAULTS: Settings = { localIp: '', lastMediaDir: '' }

/** Long enough to collapse a drag into one write, short enough to survive a quit. */
const WRITE_DEBOUNCE_MS = 500

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * The single in-memory copy of what is queued to be on disk.
 *
 * `updateSettings` merges a patch into this rather than replacing it, and a
 * write flushes whatever this holds at the moment the debounce timer fires —
 * never the patch that scheduled the timer. That is what makes two different
 * fields, each set by its own caller inside one 500 ms window, both survive:
 * before this, `localIp` and `lastMediaDir` set within the same window raced
 * to be `pending`, and the loser's write never happened.
 *
 * Holds every key that was on disk at the last `loadSettings`, not only the
 * ones this build's `Settings` type knows about. A field a newer build wrote
 * and this build has never heard of would otherwise be dropped the next time
 * anything here writes the file — an older build round-tripping a newer one's
 * settings into data loss for a preference nobody here touched.
 */
let current: Record<string, unknown> = { ...DEFAULTS }

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
    current = { ...DEFAULTS }
    return { ...DEFAULTS }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    const obj = parsed as Record<string, unknown>
    const localIp = typeof obj.localIp === 'string' ? obj.localIp : DEFAULTS.localIp
    const lastMediaDir = typeof obj.lastMediaDir === 'string' ? obj.lastMediaDir : DEFAULTS.lastMediaDir
    // Keep every field that was on disk (see the comment above `current`), but
    // normalise the two this build understands so a corrupt value on either
    // does not get written straight back out on the next flush.
    current = { ...obj, localIp, lastMediaDir }
    return { localIp, lastMediaDir }
  } catch (error) {
    process.stderr.write(`settings.json is unreadable, using defaults: ${String(error)}\n`)
    current = { ...DEFAULTS }
    return { ...DEFAULTS }
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  writeTimer = null
  try {
    writeFileSync(settingsPath(), `${JSON.stringify(current, null, 2)}\n`)
  } catch (error) {
    // A read-only or full disk loses the preference, and nothing more. Saying
    // so beats a silent no-op that has the operator re-picking the same NIC
    // every launch with no idea why it will not stick.
    process.stderr.write(`could not write settings.json: ${String(error)}\n`)
  }
}

/**
 * Merge a patch into the current settings and queue a debounced write.
 *
 * Merges rather than replaces — the bug this replaces was `saveSettings(next:
 * Settings)` taking the *whole* object, so the last of two nearby callers each
 * building their own full copy silently erased whatever the other had just
 * set. A patch can only ever add to or overwrite the keys it names.
 */
export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
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
