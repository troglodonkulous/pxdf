import { describe, expect, it } from 'vitest'
import { PICKER_EXTENSIONS } from '../src/player/mediaFormats'

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
