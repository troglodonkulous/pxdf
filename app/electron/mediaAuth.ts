import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

/**
 * The second authorisation path `pxdf-media://` will serve a file over,
 * alongside `main.ts`'s existing `allowedMedia` set of individually
 * picker-returned paths.
 *
 * `allowedMedia` answers "did the operator open exactly this file". This
 * answers a different question — "is this file a sibling of a file the
 * operator opened" — because the Cue Library lists a whole folder, and
 * listing a folder without this would mean either re-authorising every file
 * in it by hand (defeats the point of a library) or trusting whatever path
 * the renderer asks for (the renderer is the untrusted side of
 * `contextIsolation` by design, and that is a read-any-file primitive).
 *
 * Everything here is pure with respect to Electron — it takes plain strings
 * and touches only `node:fs` and `node:path` — so it is testable against a
 * real temporary directory and real symlinks, which is the only way a claim
 * about `realpath` defeating a symlink escape is actually checked rather than
 * assumed.
 */

/**
 * Canonicalise a folder the operator picked, or `null` if it does not resolve
 * to a real, currently-existing directory.
 *
 * `realpath` is what makes a later comparison against this value mean
 * anything: an un-resolved path can differ from itself across two calls (a
 * trailing slash, a `..`, a symlink in the middle) without the folder having
 * changed, and comparing two differently-spelled names for the same directory
 * as unequal would refuse legitimate siblings just as readily as it refuses
 * real outsiders.
 *
 * `null` on any failure — missing, permission denied, not a directory —
 * rather than throwing. A folder that has been unplugged or renamed since it
 * was picked is an ordinary event (a USB drive, a network share), and the
 * caller's correct response is "nothing is authorised", the same as if
 * nothing had ever been picked. Silent about *why* on purpose: this runs on
 * every launch and on every pick, and a folder that is legitimately absent —
 * nothing picked yet — must not print like a fault.
 */
export function canonicalDir(path: string): string | null {
  if (path.length === 0) return null
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * Whether `requestedPath` may be served as a library file, and the canonical
 * path to actually read if so.
 *
 * Two conditions, both required:
 *
 *   - **Not recursive.** The requested path's canonical *parent* is exactly
 *     `authorizedDir` — a direct sibling of whatever the operator originally
 *     picked from that folder, and nothing in a subdirectory of it. A prefix
 *     check on the un-resolved path (`path.startsWith(authorizedDir)`) would
 *     authorise a subdirectory too, and a symlink inside the folder pointing
 *     anywhere would authorise its target sight unseen — `realpath` on the
 *     requested path is what closes that, by resolving the symlink to what it
 *     actually points at *before* the parent is compared.
 *   - **A regular file with a `PICKER_EXTENSIONS` suffix.** Same rule the
 *     picker's own dialog filter enforces, applied again here because the
 *     dialog is a courtesy an attacker does not have to go through — this is
 *     the actual gate. Directories, device files and sockets are refused by
 *     `isFile()` regardless of name.
 *
 * `authorizedDir` must already be canonical (`canonicalDir`'s return value) —
 * this function does not re-resolve it, so the caller owns re-deriving it
 * whenever the authorised folder changes rather than on every request.
 */
export function servableLibraryFile(
  requestedPath: string,
  authorizedDir: string | null,
  extensions: readonly string[],
): string | null {
  if (authorizedDir === null) return null

  let real: string
  try {
    real = realpathSync(requestedPath)
  } catch {
    return null
  }

  let isFile: boolean
  try {
    isFile = statSync(real).isFile()
  } catch {
    return null
  }
  if (!isFile) return null

  const ext = extname(real).slice(1).toLowerCase()
  if (!extensions.includes(ext)) return null

  return dirname(real) === authorizedDir ? real : null
}

/**
 * The servable library files directly inside an already-canonical authorised
 * folder, as canonical absolute paths.
 *
 * Filtered through `servableLibraryFile` per entry rather than trusting
 * `readdirSync`'s own listing: a directory entry with a `PICKER_EXTENSIONS`
 * name can still be a symlink to somewhere outside the folder, or to a
 * subdirectory, and the enumerated list must not hand the renderer a path it
 * could not otherwise have gotten served.
 */
export function listLibraryFiles(authorizedDir: string, extensions: readonly string[]): string[] {
  let names: string[]
  try {
    names = readdirSync(authorizedDir)
  } catch {
    return []
  }

  const files: string[] = []
  for (const name of names) {
    const resolved = servableLibraryFile(join(authorizedDir, name), authorizedDir, extensions)
    if (resolved !== null) files.push(resolved)
  }
  return files.sort((a, b) => a.localeCompare(b))
}
