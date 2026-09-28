/**
 * `src/player/mediaRange.ts`, which decides what `ddf-media://` does with a
 * `Range` header.
 *
 * ## Why this is graded here and not only in `wire.mjs`
 *
 * The wire gate can tell you that a `moov`-at-end clip plays, which is the
 * operator-visible consequence and the thing that actually matters. It cannot
 * tell you *which* of the range cases were exercised getting there — Chromium
 * opens a media resource with `bytes=0-` and a tail read, and never sends the
 * suffix form, the inverted form, or a multi-range. Those paths exist in the
 * handler regardless, and a path with no gate on it is a path that is wrong
 * whenever someone next edits it.
 *
 * ## The distinction this file exists to protect
 *
 * `ignore` and `unsatisfiable` are different answers, and the whole point of
 * modelling them as separate variants rather than as `null` is that they lead
 * to different responses: a `200` with the whole file, and a `416` with none of
 * it. Collapsing them in either direction is a bug that does not look like one
 * — a `200` served where a `416` was owed hands the client the *beginning* of
 * the file when it asked for bytes past the end, and the client has no way to
 * notice.
 */

import { describe, expect, it } from 'vitest'
import {
  contentRangeHeader,
  parseRange,
  rangeLength,
  unsatisfiableRangeHeader,
} from '../src/player/mediaRange'

const SIZE = 1_000

describe('a single explicit range', () => {
  it('reads an inclusive slice', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ kind: 'range', start: 0, end: 99 })
  })

  it('counts an inclusive slice as end - start + 1 bytes', () => {
    // The off-by-one that would otherwise show up as a stall: a body one byte
    // shorter than the `Content-Length` promised leaves the pipeline waiting
    // for a byte that is never sent.
    expect(rangeLength({ start: 0, end: 99 })).toBe(100)
    expect(rangeLength({ start: 500, end: 500 })).toBe(1)
  })

  it('reads a slice that does not start at zero', () => {
    expect(parseRange('bytes=500-799', SIZE)).toEqual({ kind: 'range', start: 500, end: 799 })
  })

  it('reads a single byte', () => {
    expect(parseRange('bytes=42-42', SIZE)).toEqual({ kind: 'range', start: 42, end: 42 })
  })

  it('clamps an end past the last byte rather than refusing it', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 })
  })

  it('reaches the last byte and not one past it', () => {
    expect(parseRange('bytes=999-999', SIZE)).toEqual({ kind: 'range', start: 999, end: 999 })
  })
})

describe('an open-ended range', () => {
  // This is the form Chromium opens a media resource with, so it is the one
  // case that must be right for anything at all to play.
  it('runs from the offset to the end of the file', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
    expect(parseRange('bytes=700-', SIZE)).toEqual({ kind: 'range', start: 700, end: 999 })
  })
})

describe('a suffix range', () => {
  /**
   * `bytes=-N` is the last N bytes, not an absolute offset — and this is the
   * case the whole fix turns on. A `moov` atom at the end of an MP4 is read
   * with a tail request; reading `-N` as "start at N" serves plausible bytes
   * from the wrong end of the file, which is exactly the failure that produced
   * 105 `DEMUXER_ERROR_COULD_NOT_OPEN` lines in one night.
   */
  it('takes the last N bytes', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 })
  })

  it('takes the whole file when the suffix is longer than it', () => {
    expect(parseRange('bytes=-99999', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 })
  })

  it('cannot be satisfied when it asks for nothing', () => {
    // RFC 7233 §2.1: a zero-length suffix is well formed and unsatisfiable by
    // every resource. Not an `ignore` — the client's meaning is perfectly clear.
    expect(parseRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('a range the resource cannot satisfy', () => {
  it('is 416 when it starts past the end', () => {
    expect(parseRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('is 416 rather than an empty 206 against an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('names the resource size, which is the useful half of a 416', () => {
    // Without the size the client can only repeat the request it just got
    // refused. `*` because no bytes are being sent, per RFC 7233 §4.2.
    expect(unsatisfiableRangeHeader(SIZE)).toBe('bytes */1000')
    expect(unsatisfiableRangeHeader(0)).toBe('bytes */0')
  })
})

describe('headers a satisfied range carries', () => {
  it('describes the slice and the whole resource, inclusive', () => {
    expect(contentRangeHeader({ start: 0, end: 99 }, SIZE)).toBe('bytes 0-99/1000')
    expect(contentRangeHeader({ start: 900, end: 999 }, SIZE)).toBe('bytes 900-999/1000')
  })
})

describe('headers that are ignored, so the whole file is served', () => {
  /**
   * Ignored and **not** 416. A header this handler cannot parse is not evidence
   * that the client wanted a slice that does not exist; it is evidence that we
   * do not know what it wanted, and the whole file answers every question a
   * range could have asked. Refusing with a 416 here would turn a clip that
   * plays into a clip that does not, over a header nobody read.
   */
  it.each([
    ['no header at all', null],
    ['an undefined header', undefined],
    ['an empty string', ''],
    ['a unit that is not bytes', 'items=0-10'],
    ['a unit that is not bytes and not a range either', 'chars=0-'],
    ['nothing after the unit', 'bytes='],
    ['a bare dash naming neither end', 'bytes=-'],
    ['words', 'bytes=first-last'],
    ['a negative offset', 'bytes=-10-20'],
    ['a decimal offset', 'bytes=1.5-9'],
    ['an inverted spec', 'bytes=500-100'],
    ['trailing rubbish', 'bytes=0-99 and then some'],
  ])('ignores %s', (_name, header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'ignore' })
  })

  /**
   * Multi-range is ignored deliberately, and this is the check that says so
   * rather than leaving it to be rediscovered.
   *
   * Answering one means `multipart/byteranges` — a second body format, with
   * boundaries, for a case Chromium's media pipeline does not generate. Serving
   * only the first range under a plain `206` would be worse than ignoring it:
   * the body would not hold what the headers claim and the client could not
   * tell. RFC 7233 §4.1 lets a server ignore a `Range` it does not wish to
   * honour, and a `200` is always a correct answer to a range request.
   */
  it('ignores a multi-range rather than answering part of it', () => {
    expect(parseRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'ignore' })
    expect(parseRange('bytes=0-99, 200-', SIZE)).toEqual({ kind: 'ignore' })
  })

  it('ignores a nonsensical resource size rather than computing against it', () => {
    // Belt and braces on the handler's own `statSync`: a negative or fractional
    // size cannot produce a meaningful slice, and serving the whole file is the
    // answer that cannot be subtly wrong.
    expect(parseRange('bytes=0-', -1)).toEqual({ kind: 'ignore' })
    expect(parseRange('bytes=0-', 1.5)).toEqual({ kind: 'ignore' })
  })
})

describe('the spellings a real client actually sends', () => {
  // Case and whitespace are both legal in the header's grammar, and a parser
  // that only accepts the canonical spelling silently serves a whole file to a
  // client that asked for a slice — the exact failure mode being fixed.
  it.each([
    'bytes=0-99',
    'Bytes=0-99',
    'BYTES=0-99',
    'bytes =0-99',
    'bytes= 0-99',
    ' bytes=0-99 ',
    'bytes=0 - 99',
  ])('parses %s the same way', (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'range', start: 0, end: 99 })
  })
})
