import { describe, expect, it } from 'vitest'
import { MEDIA_SCHEME, mediaPath, mediaUrl } from '../src/player/mediaUrl'

/**
 * `mediaUrl` runs in the renderer and `mediaPath` runs in the main process, and
 * they have to be exact inverses for two separate reasons.
 *
 * The old one: a path that does not survive the round trip is a cue that will
 * not load, for a reason nothing in the UI can explain.
 *
 * The new one, and the reason this file exists at all: `main.ts` now serves only
 * paths in `allowedMedia`, and it fills that set with the strings the *picker*
 * returned while testing membership against the string `mediaPath` produced. A
 * round trip that is not exact turns every cue into a 403.
 */
describe('the media URL round trip', () => {
  const paths = [
    '/Users/rob/clips/loop.mp4',
    '/Users/rob/Test Clips/red - 108070 (Original).mp4',
    '/Users/rob/clips/100% #1 what?.mov',
    '/Users/rob/clips/ünïcode ✨ né.webm',
    '/Users/rob/clips/a&b=c;d.mp4',
    "/Users/rob/clips/it's [fine] (really).m4v",
    '/var/folders/lc/5bhyvxbj4rn8426kp6g_bhsh0000gn/T/pxdf-e2e-Xk9/red.mp4',
  ]

  it.each(paths)('survives %s', (path) => {
    expect(mediaPath(mediaUrl(path))).toBe(path)
  })

  it('produces a URL on our scheme and nothing else', () => {
    for (const path of paths) {
      expect(mediaUrl(path).startsWith(`${MEDIA_SCHEME}://`)).toBe(true)
    }
  })

  it('keeps separators as structure rather than encoding them away', () => {
    // If the separators were escaped the URL would still round trip, but it
    // would be one opaque segment — and `new URL` would no longer normalise it,
    // which is the thing that makes the round trip trustworthy in the first
    // place.
    expect(mediaUrl('/a/b/c.mp4')).toBe(`${MEDIA_SCHEME}://file/a/b/c.mp4`)
  })

  it('round trips a Windows path, separators and drive letter included', () => {
    expect(mediaPath(mediaUrl('C:\\clips\\loop.mp4'))).toBe('C:/clips/loop.mp4')
  })
})

describe('mediaPath refuses what it cannot name', () => {
  it.each([
    ['a foreign scheme', 'file:///Users/rob/clips/loop.mp4'],
    ['an http URL', 'http://example.com/loop.mp4'],
    ['nonsense', 'not a url at all'],
    ['an empty path', `${MEDIA_SCHEME}://file`],
  ])('rejects %s', (_name, url) => {
    expect(mediaPath(url)).toBeNull()
  })

  it('rejects a malformed percent escape rather than throwing', () => {
    // `decodeURIComponent` throws on a stray `%`. This runs inside a protocol
    // handler, where an exception is a request that never gets a response.
    expect(mediaPath(`${MEDIA_SCHEME}://file/clips/%zz.mp4`)).toBeNull()
  })
})
