import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs script, run by `npm run dist` before any build exists
import { dirtyPaths, formatBuildString, readBuild, releaseRefusal } from '../scripts/releaseTree.mjs'

describe('dirtyPaths', () => {
  it('reads paths from porcelain lines, including the leading-space status column', () => {
    expect(dirtyPaths(' M app/src/App.tsx\n?? app/src/new.ts\nA  mapper/cli.py\n')).toEqual([
      'app/src/App.tsx',
      'app/src/new.ts',
      'mapper/cli.py',
    ])
  })

  it('reads a clean tree as no paths, not as one empty path', () => {
    expect(dirtyPaths('')).toEqual([])
  })
})

describe('formatBuildString', () => {
  it('marks a dirty build in the string itself', () => {
    expect(formatBuildString('floor-2026-10-01-3-gabc1234', ['app/x'])).toBe('floor-2026-10-01-3-gabc1234-dirty')
  })

  it('leaves a clean build as git describes it', () => {
    expect(formatBuildString('floor-2026-10-01', [])).toBe('floor-2026-10-01')
  })
})

describe('releaseRefusal', () => {
  it('lets a clean tree through', () => {
    expect(releaseRefusal('floor-2026-10-01', [], false)).toBeNull()
  })

  it('refuses a dirty tree and names what is dirty', () => {
    const refusal = releaseRefusal('abc1234-dirty', ['app/src/App.tsx'], false)
    expect(refusal).toContain('refusing to build')
    expect(refusal).toContain('app/src/App.tsx')
  })

  // An unreadable provenance must never read as a clean one.
  it('refuses when git could not be read, exactly as it refuses a dirty tree', () => {
    expect(releaseRefusal('unknown', [], false)).toContain('refusing to build')
  })

  it('lets the override through', () => {
    expect(releaseRefusal('abc1234-dirty', ['app/src/App.tsx'], true)).toBeNull()
  })
})

describe('readBuild', () => {
  // Positive control on the real checkout: the probe runs inside a git repo, so
  // an `unknown` here means the reader is broken, not that the tree is odd.
  it('reads this checkout', () => {
    const { buildString } = readBuild()
    expect(buildString).not.toBe('unknown')
    expect(buildString).toMatch(/^[\w.-]+$/)
  })
})
