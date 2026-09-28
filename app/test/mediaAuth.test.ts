/**
 * `electron/mediaAuth.ts`, graded against a real filesystem — real
 * directories, real files, real symlinks.
 *
 * This is the module that decides whether widening `ddf-media://` from
 * "individually opened files" to "a whole picked folder" hands the renderer
 * anything it should not have. `CLAUDE.md`'s rule is to check provenance, not
 * plausibility, and a security boundary is exactly the kind of claim that
 * deserves a real disproof attempt rather than a mocked `realpath` that
 * cannot lie the way a real symlink can.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalDir, listLibraryFiles, servableLibraryFile } from '../electron/mediaAuth'

const EXT = ['mp4', 'mov', 'webm']

let root: string
let library: string // the "picked" folder, already canonical — see the note below
let outside: string // a genuinely unrelated folder

beforeEach(() => {
  // `realpath`d immediately, and not a test nicety: `os.tmpdir()` on macOS
  // returns a path under `/var`, which is itself a symlink to `/private/var`.
  // `servableLibraryFile` documents that its `authorizedDir` argument must
  // already be canonical — production code gets that from `canonicalDir` on
  // the freshly-picked folder — so a test that skipped this step would be
  // asserting against an authorizedDir that violates its own precondition,
  // and every comparison inside the function would fail for a reason that has
  // nothing to do with the property under test.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ddf-mediaauth-test-')))
  library = join(root, 'library')
  outside = join(root, 'outside')
  mkdirSync(library)
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('canonicalDir', () => {
  it('resolves a real directory', () => {
    expect(canonicalDir(library)).toBe(library)
  })

  it('returns null for a path that does not exist', () => {
    expect(canonicalDir(join(root, 'never-picked'))).toBe(null)
  })

  it('returns null for a path that is a file, not a directory', () => {
    const file = join(library, 'clip.mp4')
    writeFileSync(file, 'x')
    expect(canonicalDir(file)).toBe(null)
  })

  it('returns null for an empty string', () => {
    // The "nothing picked yet" / default-settings case, and it must not
    // resolve to some ambient current-working-directory guess.
    expect(canonicalDir('')).toBe(null)
  })

  it('resolves through a symlinked directory to its real path', () => {
    const link = join(root, 'library-link')
    symlinkSync(library, link)
    expect(canonicalDir(link)).toBe(library)
  })
})

describe('servableLibraryFile', () => {
  it('serves a sibling file directly inside the authorised folder', () => {
    const clip = join(library, 'red.mp4')
    writeFileSync(clip, 'x')
    expect(servableLibraryFile(clip, library, EXT)).toBe(clip)
  })

  it('refuses everything when no folder is authorised', () => {
    const clip = join(library, 'red.mp4')
    writeFileSync(clip, 'x')
    expect(servableLibraryFile(clip, null, EXT)).toBe(null)
  })

  it('refuses a file nested one directory deeper — not recursive', () => {
    const nestedDir = join(library, 'subfolder')
    mkdirSync(nestedDir)
    const nested = join(nestedDir, 'red.mp4')
    writeFileSync(nested, 'x')
    expect(servableLibraryFile(nested, library, EXT)).toBe(null)
  })

  it('refuses a file in a genuinely unrelated folder', () => {
    const elsewhere = join(outside, 'green.mp4')
    writeFileSync(elsewhere, 'x')
    expect(servableLibraryFile(elsewhere, library, EXT)).toBe(null)
  })

  it('refuses a file with an extension the picker does not offer', () => {
    const doc = join(library, 'notes.txt')
    writeFileSync(doc, 'x')
    expect(servableLibraryFile(doc, library, EXT)).toBe(null)
  })

  it('refuses a directory even if it is named like a video file', () => {
    const fakeFile = join(library, 'trap.mp4')
    mkdirSync(fakeFile)
    expect(servableLibraryFile(fakeFile, library, EXT)).toBe(null)
  })

  it('refuses a path that does not exist', () => {
    expect(servableLibraryFile(join(library, 'ghost.mp4'), library, EXT)).toBe(null)
  })

  /**
   * The attack this whole module exists to close. A prefix check on the
   * un-resolved path (`path.startsWith(authorizedDir)`) would authorise this,
   * because the symlink's own path is inside `library` — it is only
   * `realpath` resolving to where the symlink actually points that catches
   * it.
   */
  it('refuses a symlink inside the authorised folder that escapes it', () => {
    const secret = join(outside, 'secret.mp4')
    writeFileSync(secret, 'x')
    const escape = join(library, 'looks-local.mp4')
    symlinkSync(secret, escape)
    expect(servableLibraryFile(escape, library, EXT)).toBe(null)
  })

  it('serves a symlink that stays inside the authorised folder', () => {
    const real = join(library, 'red.mp4')
    writeFileSync(real, 'x')
    const alias = join(library, 'alias.mp4')
    symlinkSync(real, alias)
    expect(servableLibraryFile(alias, library, EXT)).toBe(real)
  })
})

describe('listLibraryFiles', () => {
  it('lists only matching-extension regular files directly in the folder', () => {
    writeFileSync(join(library, 'red.mp4'), 'x')
    writeFileSync(join(library, 'blue.mov'), 'x')
    writeFileSync(join(library, 'notes.txt'), 'x')
    mkdirSync(join(library, 'subfolder'))

    expect(listLibraryFiles(library, EXT)).toEqual(
      [join(library, 'blue.mov'), join(library, 'red.mp4')].sort(),
    )
  })

  it('excludes a symlink that escapes the folder', () => {
    writeFileSync(join(library, 'red.mp4'), 'x')
    writeFileSync(join(outside, 'secret.mp4'), 'x')
    symlinkSync(join(outside, 'secret.mp4'), join(library, 'escape.mp4'))

    expect(listLibraryFiles(library, EXT)).toEqual([join(library, 'red.mp4')])
  })

  it('returns an empty list for a folder that no longer exists, rather than throwing', () => {
    expect(listLibraryFiles(join(root, 'gone'), EXT)).toEqual([])
  })

  it('returns an empty list for an empty folder', () => {
    expect(listLibraryFiles(library, EXT)).toEqual([])
  })
})
