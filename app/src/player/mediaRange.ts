/**
 * The `Range` header of a `ddf-media://` request, turned into a decision.
 *
 * ## Why this exists at all
 *
 * The handler used to serve every request with `net.fetch` over a `file://`
 * URL, which cannot answer a range request: `Range: bytes=0-` comes back `200`
 * with the whole file and no `Content-Range`. That was recorded as a harmless
 * limitation — "seeking works because Chromium buffers what it is given" — and
 * it was not harmless, because the scheme is registered `stream: true` and
 * Chromium reports `kIsRangeHeaderSupported=true` for it. Chromium therefore
 * *issued* range requests and was silently handed byte 0 of the file every
 * time, whatever offset it asked for.
 *
 * An MP4 whose `moov` atom sits after `mdat` — which is what `ffmpeg` writes
 * unless it is asked for `+faststart` — has to be read from the tail before a
 * single frame can be decoded. With the offsets silently wrong, that read never
 * lands and the container never opens. MEASURED over one night's job log: of
 * 131 clips matched to both a file on disk and a verdict in the log, every one
 * of the 124 with `moov` at the front played and all 7 with `moov` at the end
 * failed, including a within-folder control (13 `FRONT` played, 7 `END` failed,
 * same directory) that rules out the authorisation path as the explanation.
 * 105 `DEMUXER_ERROR_COULD_NOT_OPEN` lines in one night came from this.
 *
 * That correlation was found in the data that produced the theory, so it was
 * then tested out of sample on a clip the log has no verdict for at all:
 * `test/e2e/probe-moov-clip.mjs`, whose header records the before-and-after.
 * It failed with `DEMUXER_ERROR_COULD_NOT_OPEN` on the pre-fix build and plays
 * on this one, while its own `+faststart` remux — same frames, same codec —
 * played on both.
 *
 * ## Why it is its own module, with no Electron in it
 *
 * Range parsing is the part that can be wrong in ways nothing downstream will
 * say out loud. An off-by-one on the inclusive end, a suffix range read as an
 * absolute offset, a `Content-Length` that disagrees with the slice — each of
 * those produces bytes that arrive, decode partly, and fail somewhere that does
 * not name the range. Keeping it pure means `vitest` grades it directly instead
 * of a `wire.mjs` run having to imply it, which is this project's "two
 * harnesses, and no third" rule applied to the half that is ordinary logic.
 */

/**
 * What the handler should do with a request, given its `Range` header.
 *
 * Three outcomes and not two, because "ignore this header and serve the whole
 * file" and "this range cannot be satisfied" are different things that the
 * operator sees differently: the first is an ordinary `200` and a clip that
 * plays, the second is a `416` and a clip that does not. Modelling either one
 * as `null` would let a caller collapse them by accident, and a `200` served
 * where a `416` was owed is a wrong answer that looks like a right one — the
 * shape of failure this repo keeps a postmortems file about.
 */
export type RangeRequest =
  /** Serve exactly `[start, end]`, inclusive, as a `206`. */
  | { kind: 'range'; start: number; end: number }
  /** Nothing in the resource can satisfy it: `416`, `Content-Range: bytes * /SIZE`. */
  | { kind: 'unsatisfiable' }
  /** No usable range here. Serve the ordinary whole-body `200`. */
  | { kind: 'ignore' }

/**
 * Parse a `Range` header against a resource of `size` bytes.
 *
 * `header` is `null` when the request carried none, which is the common case
 * and is an `ignore` like any other unusable header.
 *
 * Deliberately narrow, in two places:
 *
 *   - **Multi-range is `ignore`, not an error.** Answering one would mean
 *     emitting `multipart/byteranges`, a second body format with its own
 *     boundary handling, for a case Chromium's media pipeline does not
 *     generate. RFC 7233 §4.1 permits a server to ignore a `Range` header it
 *     does not wish to honour, and serving the whole file is always a correct
 *     answer. Implementing a format nothing here exercises would be a second
 *     untested path, not a feature.
 *   - **Anything malformed is `ignore`.** A header we cannot parse is not
 *     evidence that the client wanted a slice we cannot give; it is evidence we
 *     do not know what it wanted, and the whole file answers every question.
 *     `416` is reserved for the case where the client's meaning is perfectly
 *     clear and the resource simply does not contain those bytes.
 */
export function parseRange(header: string | null | undefined, size: number): RangeRequest {
  if (header === null || header === undefined) return { kind: 'ignore' }
  if (!Number.isInteger(size) || size < 0) return { kind: 'ignore' }

  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(header)
  if (match === null) return { kind: 'ignore' }

  const spec = match[1].trim()
  if (spec.length === 0) return { kind: 'ignore' }
  // Multi-range. Refused here rather than half-answered: serving only the first
  // range of several under a plain `206` would be a lie about what the body
  // holds, and the client has no way to detect it.
  if (spec.includes(',')) return { kind: 'ignore' }

  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec)
  if (parts === null) return { kind: 'ignore' }

  const firstText = parts[1]
  const lastText = parts[2]

  // `bytes=-N`: the last N bytes. Not an absolute offset, and reading it as one
  // is the single most likely way to get this wrong — it serves plausible bytes
  // from the wrong end of the file.
  if (firstText.length === 0) {
    if (lastText.length === 0) return { kind: 'ignore' } // "bytes=-" names nothing.
    const suffix = Number(lastText)
    if (!Number.isSafeInteger(suffix)) return { kind: 'ignore' }
    // A zero-length suffix is well formed and cannot be satisfied by any
    // resource, per RFC 7233 §2.1. An empty file cannot satisfy anything either.
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' }
    const start = Math.max(0, size - suffix)
    return { kind: 'range', start, end: size - 1 }
  }

  const start = Number(firstText)
  if (!Number.isSafeInteger(start)) return { kind: 'ignore' }

  // Past the end of the resource — including every range against an empty one.
  // This is the case `416` exists for: the request is unambiguous and the bytes
  // are not there.
  if (start >= size) return { kind: 'unsatisfiable' }

  // `bytes=N-`: N through the end. This is the form Chromium opens a media
  // resource with.
  if (lastText.length === 0) return { kind: 'range', start, end: size - 1 }

  const requestedEnd = Number(lastText)
  if (!Number.isSafeInteger(requestedEnd)) return { kind: 'ignore' }
  // An inverted spec is malformed rather than unsatisfiable: RFC 7233 §2.1
  // makes `last-byte-pos < first-byte-pos` an invalid byte-range-spec, and an
  // invalid spec is ignored.
  if (requestedEnd < start) return { kind: 'ignore' }

  // Clamped, not refused. A client asking for more than the file holds gets
  // what the file holds, which is what `Content-Range: bytes START-END/SIZE`
  // then truthfully describes.
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) }
}

/** How many bytes a satisfied range covers. Inclusive on both ends. */
export function rangeLength(range: { start: number; end: number }): number {
  return range.end - range.start + 1
}

/** The `Content-Range` value for a satisfied range. */
export function contentRangeHeader(range: { start: number; end: number }, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

/**
 * The `Content-Range` value for a `416`.
 *
 * The `*` is required, and it is the part that makes a 416 useful: it tells the
 * client the resource's actual size, so the next request can be one that can be
 * satisfied rather than the same wrong one again.
 */
export function unsatisfiableRangeHeader(size: number): string {
  return `bytes */${size}`
}
