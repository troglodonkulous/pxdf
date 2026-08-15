/**
 * `electron/settings.ts`, graded against a real temp directory rather than a
 * fake filesystem.
 *
 * A settings file that a corrupt read or a full disk can turn into an app
 * that will not launch is exactly the shape of failure `CLAUDE.md` opens
 * with, so this reads and writes real files rather than trusting a mock of
 * `node:fs` to behave the way the real one does under a bad path or bad JSON.
 * Only `electron`'s `app.getPath` is faked, because nothing here is actually
 * running inside Electron.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const getPath = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { getPath } }))

const { loadSettings, updateSettings, flushSettings } = await import('../electron/settings')

let dir: string

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'ddf-settings-test-'))
  getPath.mockReturnValue(dir)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function settingsFile(): string {
  return join(dir, 'settings.json')
}

describe('loadSettings', () => {
  it('returns defaults when nothing is on disk yet', () => {
    expect(loadSettings()).toEqual({ localIp: '', lastMediaDir: '' })
    expect(existsSync(settingsFile())).toBe(false)
  })

  it('reads back what was written', () => {
    writeFileSync(settingsFile(), JSON.stringify({ localIp: '10.200.50.78', lastMediaDir: '/clips' }))
    expect(loadSettings()).toEqual({ localIp: '10.200.50.78', lastMediaDir: '/clips' })
  })

  it('falls back to defaults on unparseable JSON, without throwing', () => {
    writeFileSync(settingsFile(), '{ not json')
    expect(() => loadSettings()).not.toThrow()
    expect(loadSettings()).toEqual({ localIp: '', lastMediaDir: '' })
  })

  it('falls back to defaults when the file is not a JSON object', () => {
    writeFileSync(settingsFile(), JSON.stringify([1, 2, 3]))
    expect(loadSettings()).toEqual({ localIp: '', lastMediaDir: '' })
  })

  it('replaces a field of the wrong type with its default rather than propagating it', () => {
    writeFileSync(settingsFile(), JSON.stringify({ localIp: 42, lastMediaDir: null }))
    expect(loadSettings()).toEqual({ localIp: '', lastMediaDir: '' })
  })
})

/**
 * The point of the change. Before this, `saveSettings(next: Settings)` took
 * the whole object, so two callers racing inside the 500 ms debounce window —
 * one setting `localIp`, one setting `lastMediaDir` — each built their own
 * full copy from what they already knew, and the second call's write erased
 * the first caller's field. This is now structurally impossible: a patch can
 * only add to or overwrite the keys it names.
 */
describe('updateSettings merges patches inside one debounce window', () => {
  it('keeps both fields when two different patches land before the flush', () => {
    loadSettings()
    updateSettings({ localIp: '10.200.50.78' })
    vi.advanceTimersByTime(200)
    updateSettings({ lastMediaDir: '/Users/rob/clips' })
    vi.advanceTimersByTime(500)

    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toMatchObject({
      localIp: '10.200.50.78',
      lastMediaDir: '/Users/rob/clips',
    })
  })

  it('the second patch to the same field inside the window wins, not the first', () => {
    loadSettings()
    updateSettings({ localIp: 'first' })
    vi.advanceTimersByTime(100)
    updateSettings({ localIp: 'second' })
    vi.advanceTimersByTime(500)

    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).localIp).toBe('second')
  })

  it('collapses many patches inside the window into one write', () => {
    loadSettings()
    const before = existsSync(settingsFile())
    // 9 patches 50 ms apart is 450 ms of elapsed time from the first one,
    // still inside its 500 ms window; the 10th pushes past it.
    for (let i = 0; i < 9; i++) {
      updateSettings({ localIp: `10.0.0.${i}` })
      vi.advanceTimersByTime(50)
    }
    expect(before, 'nothing should have been written yet').toBe(false)
    expect(existsSync(settingsFile()), 'the debounce window should not have elapsed yet').toBe(false)
    updateSettings({ localIp: '10.0.0.9' })
    vi.advanceTimersByTime(500)
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).localIp).toBe('10.0.0.9')
  })
})

describe('preserving fields this build does not know about', () => {
  it('round-trips an unknown field through a load, a patch and a flush', () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ localIp: '10.200.50.78', lastMediaDir: '', sidebarWidth: 240 }),
    )
    loadSettings()
    updateSettings({ lastMediaDir: '/clips' })
    vi.advanceTimersByTime(500)

    const onDisk = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    expect(onDisk.sidebarWidth, 'a field written by a newer build must survive an older one round-tripping it').toBe(240)
    expect(onDisk.lastMediaDir).toBe('/clips')
    expect(onDisk.localIp).toBe('10.200.50.78')
  })
})

describe('flushSettings', () => {
  it('writes immediately, without waiting for the debounce timer', () => {
    loadSettings()
    updateSettings({ localIp: '192.168.1.1' })
    expect(existsSync(settingsFile())).toBe(false)
    flushSettings()
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).localIp).toBe('192.168.1.1')
  })

  it('is a no-op when nothing is queued', () => {
    loadSettings()
    expect(() => flushSettings()).not.toThrow()
  })
})

describe('a write failure is loud, not silent', () => {
  it('does not throw when the write itself fails, and says so on stderr', () => {
    loadSettings()
    // A path that cannot exist as a directory: writing through a file used as
    // a path segment. Deliberately not `rmSync`-ing `dir` — the point is a
    // *write* failure, not a missing directory `loadSettings` already treats
    // as first-launch.
    getPath.mockReturnValue(join(dir, 'settings.json', 'nested'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    updateSettings({ localIp: '10.0.0.1' })
    expect(() => flushSettings()).not.toThrow()
    expect(stderr).toHaveBeenCalled()
    stderr.mockRestore()
  })
})
