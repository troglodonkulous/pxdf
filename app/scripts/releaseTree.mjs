/**
 * What code a build is made of, as one string, and whether a show build may be
 * made from this tree at all.
 *
 * ## Why this exists
 *
 * The 2026-09-05/06 show ran for eight hours and nobody can say exactly what
 * code it ran. `docs/JOBS.md` records "unpackaged, from /Users/USER/dev/ddf,
 * on app-media-content-length" — a branch name, no commit, and no word on
 * whether the working tree had uncommitted changes. The launch log recorded the
 * Electron version and nothing about the source. So every question of the form
 * "was this fixed in what the show ran?" is unanswerable after the fact.
 *
 * `buildString` is baked into the main-process bundle at build time
 * (`vite.config.ts`, `__DDF_BUILD__`) and printed on the launch line, so the log
 * answers that question itself. `npm run dist` calls this file first and
 * refuses a dirty tree (`docs/DECISIONS.md` D-20), so a show build is a commit.
 *
 * ## One definition of dirty
 *
 * Dirty means a change under `app/` or `mapper/` — the two trees the packaged
 * app is built from and carries — including untracked files, because an
 * untracked source file can be imported into the bundle as easily as a tracked
 * one. Changes elsewhere (docs, captures) cannot change the build and do not
 * count. Both the refusal and the `-dirty` suffix read this one function, so the
 * string in the log and the gate that let the build through can never disagree.
 *
 * ## What it does when it is broken
 *
 * If git cannot be run — no git, not a checkout — the answer is `unknown`, and
 * `unknown` is treated as dirty: refused for a show build, and flagged at
 * launch. An unreadable provenance must never read as a clean one.
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The trees a packaged build is made from. */
export const BUILD_PATHS = ['app', 'mapper']

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function git(args) {
  // Not trimmed here: porcelain lines start with a status column that may be a
  // space, and trimming the whole output would shift the first path by one.
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Paths under `BUILD_PATHS` that differ from HEAD, from `git status --porcelain`
 * output. Gitignored files never appear in that output, so `node_modules` and
 * `dist` do not count.
 */
export function dirtyPaths(porcelain) {
  return porcelain
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0)
}

/** `<git describe>` plus `-dirty` when `dirty` is non-empty. */
export function formatBuildString(describe, dirty) {
  return dirty.length > 0 ? `${describe}-dirty` : describe
}

/**
 * The refusal message for a show build, or `null` when it may proceed.
 * `unknown` provenance refuses exactly as a dirty tree does.
 */
export function releaseRefusal(buildString, dirty, allowDirty) {
  if (allowDirty) return null
  if (buildString === 'unknown') {
    return 'refusing to build: cannot read this build\'s provenance from git. Set DDF_ALLOW_DIRTY=1 to override; the build will say so at every launch.'
  }
  if (dirty.length === 0) return null
  const listed = dirty.slice(0, 10).map((path) => `  ${path}`).join('\n')
  const more = dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ''
  return `refusing to build: ${dirty.length} uncommitted change(s) under ${BUILD_PATHS.join('/, ')}/ — a show build must be a commit.\n${listed}${more}\nCommit them, or set DDF_ALLOW_DIRTY=1 to override; the build will say so at every launch.`
}

/** Read the tree now. Never throws: an unreadable tree is `unknown`. */
export function readBuild() {
  try {
    const describe = git(['describe', '--tags', '--always']).trim()
    const dirty = dirtyPaths(git(['status', '--porcelain', '--untracked-files=all', '--', ...BUILD_PATHS]))
    return { buildString: formatBuildString(describe, dirty), dirty }
  } catch {
    // Not swallowed: `unknown` is the loud answer, refused and flagged downstream.
    return { buildString: 'unknown', dirty: [] }
  }
}

// `node scripts/releaseTree.mjs` — the gate `npm run dist` runs first.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { buildString, dirty } = readBuild()
  const refusal = releaseRefusal(buildString, dirty, process.env.DDF_ALLOW_DIRTY === '1')
  if (refusal !== null) {
    console.error(refusal)
    process.exit(1)
  }
  console.log(`release build: ${buildString}`)
}
