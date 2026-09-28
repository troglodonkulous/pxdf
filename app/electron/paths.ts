/**
 * Where `mapper/` lives, and what environment `python3` is spawned into.
 *
 * Both answers differ between the dev checkout and the packaged `.app`, and
 * both were previously computed inline in two places. One owner now.
 */

/**
 * The working directory `python -m mapper ...` runs in.
 *
 * Packaged, `mapper/` is copied to `Contents/Resources/mapper/` by
 * electron-builder's `extraResources` — outside `app.asar`, because
 * `python -m` needs a real filesystem tree rather than asar's virtual one.
 *
 * Worth knowing before anyone "simplifies" this away: the dev computation
 * (`resolve(dirname(main.js), '../..')`) happens to land on
 * `Contents/Resources` when packaged too, because `main.js` sits at
 * `Contents/Resources/app.asar/dist/main.js` and the bundle is exactly two
 * levels deep. That is an accident of asar layout, not an invariant, and a
 * reader cannot tell an accident from a decision. This function is the
 * decision.
 */
export function mapperCwd(isPackaged: boolean, devRepoRoot: string): string {
  return isPackaged ? process.resourcesPath : devRepoRoot
}

/**
 * The environment `python3` is spawned into.
 *
 * An app launched from Finder inherits launchd's minimal `PATH`, not the
 * shell's. `/usr/bin` is on that minimal `PATH`, so the machine this ships to —
 * which uses `/usr/bin/python3`, Python 3.9.6, graded against both digests in
 * `CLAUDE.md` — resolves without help. The prepended entries are for a
 * Homebrew-only machine, where `python3` lives at `/opt/homebrew/bin` and
 * `spawn()` cannot see it even though the same command works from Terminal.
 *
 * `PYTHONDONTWRITEBYTECODE` because `mapper/` lives inside the bundle: in
 * `/Applications` that directory is not writable, so every launch would
 * otherwise attempt a `__pycache__` write that silently fails.
 *
 * `DDF_PYTHON` is untouched — this patches `PATH`, never the binary name, so
 * the override keeps working in both modes.
 */
export function resolvePythonEnv(isPackaged: boolean): NodeJS.ProcessEnv {
  if (!isPackaged) return process.env

  return {
    ...process.env,
    PATH: [...PACKAGED_PATH_PREFIX, process.env.PATH ?? ''].join(':'),
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

const PACKAGED_PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
