import { describe, expect, it } from 'vitest'
import { mediaContentType, PICKER_EXTENSIONS, UNKNOWN_CONTENT_TYPE } from '../src/player/mediaFormats'

/**
 * Containers this Electron build fails to demux at all, measured against the
 * running app on 2026-08-13. Every one of these answers
 * `DEMUXER_ERROR_COULD_NOT_OPEN`, so the picker must never offer them.
 *
 * `avi` is the one that matters and the one most likely to come back. Every test
 * pattern in this repo is an AVI — `test-patterns/09-gradient24-8x8_4P-10x5.avi`
 * is the file the whole cutover digest is graded on — so anyone reaching for a
 * clip to try the player on finds an AVI first, discovers the picker will not
 * show it, and fixes the picker. That is the wrong fix: `mapper play` decodes
 * those with ffmpeg, and the app's `<video>` element cannot. Offering them
 * produces a cue that is added, selected, fired, and silently fails. The probe
 * covered both H.264-in-AVI and the rawvideo form this repo actually ships;
 * neither opens.
 *
 * `mkv` is deliberately **not** here, and was here in the first draft of this
 * file. Matroska decodes — Chromium's WebM demuxer is a Matroska demuxer — and
 * excluding it kept a working format out of the picker on a guess. `ogv` is not
 * here either: its container opens and only the Theora stream inside it is
 * unsupported, so it is not offered but is not claimed to be undemuxable.
 * See `mediaFormats.ts` for the measurement.
 */
const CHROMIUM_CANNOT_DECODE = ['avi', 'mpg', 'mpeg', 'wmv', 'flv']

describe('PICKER_EXTENSIONS', () => {
  it.each(CHROMIUM_CANNOT_DECODE)('does not offer %s', (extension) => {
    expect(PICKER_EXTENSIONS).not.toContain(extension)
  })

  it('offers the containers the render path was measured to play', () => {
    expect([...PICKER_EXTENSIONS]).toEqual(['mp4', 'm4v', 'mov', 'webm', 'mkv'])
  })

  // Electron's `dialog.showOpenDialog` filters take extensions bare and match
  // case-sensitively on some platforms. A leading dot or a capital silently
  // matches nothing, which reads to an operator as "the dialog cannot see my
  // files" rather than as a bug here.
  it('is in the bare lowercase form the dialog filter requires', () => {
    for (const extension of PICKER_EXTENSIONS) {
      expect(extension).not.toContain('.')
      expect(extension).toBe(extension.toLowerCase())
    }
  })

  it('is not empty, which would offer nothing at all', () => {
    expect(PICKER_EXTENSIONS.length).toBeGreaterThan(0)
  })
})

/**
 * The `Content-Type` half, which the handler did not used to own.
 *
 * Before ranges, `ddf-media://` fetched bytes with `net.fetch` over a `file://`
 * URL and passed that response's headers through, so Chromium supplied the
 * type. A `206` is built from a raw `createReadStream`, which carries no
 * headers at all — so the type is now this module's answer, on both the `200`
 * and the `206` path.
 *
 * The check that matters is not the literal strings. It is that the map and
 * `PICKER_EXTENSIONS` cannot drift apart: the picker offering a container this
 * table has never heard of would serve it `application/octet-stream`, which is
 * a silent labelling defect that surfaces, if at all, as one format failing to
 * decode for no visible reason.
 */
describe('mediaContentType', () => {
  it('has a real video type for every extension the picker offers', () => {
    for (const extension of PICKER_EXTENSIONS) {
      const type = mediaContentType(`/clips/loop.${extension}`)
      expect(type, `no Content-Type for .${extension}`).not.toBe(UNKNOWN_CONTENT_TYPE)
      expect(type.startsWith('video/'), `${extension} is labelled ${type}`).toBe(true)
    }
  })

  it('answers the same for an extension however it is capitalised', () => {
    // macOS filesystems hand back whatever case the file was created with, and
    // `.MP4` is an ordinary spelling. A case-sensitive lookup would serve those
    // files unlabelled while their lowercase twins played.
    expect(mediaContentType('/clips/LOOP.MP4')).toBe(mediaContentType('/clips/loop.mp4'))
    expect(mediaContentType('/clips/Loop.MoV')).toBe(mediaContentType('/clips/loop.mov'))
  })

  it('labels a path with no extension, and one with an unknown one, as unknown bytes', () => {
    // Not a guess at `video/mp4`. Nothing outside `PICKER_EXTENSIONS` reaches
    // the handler, so arriving here means the two lists have drifted, and
    // "unknown" is the answer that does not hide it.
    expect(mediaContentType('/clips/loop')).toBe(UNKNOWN_CONTENT_TYPE)
    expect(mediaContentType('/clips/loop.avi')).toBe(UNKNOWN_CONTENT_TYPE)
  })

  it('reads the extension, not the folder names above it', () => {
    // A directory called `x.mov` holding `loop.mp4` is a real shape, and a
    // lookup that scanned the whole path for a known extension would type the
    // file from its parent folder.
    expect(mediaContentType('/clips/take.mov/loop.mp4')).toBe('video/mp4')
  })

  it('is the same answer for the same file every time it is asked', () => {
    // The 200 path and the 206 path both call this, and the one thing they must
    // never do is disagree about a file — that defect shows up as a clip that
    // plays whole and fails when seeked, which reads as flakiness.
    const path = '/clips/take.mkv'
    expect(mediaContentType(path)).toBe(mediaContentType(path))
  })
})
