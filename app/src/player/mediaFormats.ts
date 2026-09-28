/**
 * Which containers the media picker offers.
 *
 * ## Why this is narrower than what the project can play
 *
 * `mapper play` decodes with ffmpeg and will happily read an AVI, an MKV or an
 * MPEG program stream. The app does not use ffmpeg for playback: a cue is
 * decoded by an `HTMLVideoElement` inside Chromium, which ships a deliberately
 * small set of demuxers and decoders. The two halves of this project therefore
 * do not agree about what a playable file is, and the picker has to speak for
 * the half that will actually be doing the decoding.
 *
 * PR 2 shipped a filter listing `avi`, `mkv`, `mpg` and `mpeg` alongside the
 * four that decode. Three of those four do not open at all — `mkv` is the
 * exception and is kept, for the reason in the table below. Worse, every test
 * pattern in this repo is an AVI and the ones that matter are rawvideo — so the
 * first thing anyone reaches for to try the player on was a file the player
 * could never play, and the failure arrives as a cue that is added, selected,
 * fired, and does nothing.
 *
 * ## Measured, not reasoned
 *
 * The first correction to that filter was written from what Chromium is
 * generally believed to support, and it was wrong in the other direction: it
 * dropped Matroska, which this build decodes perfectly well. So the list is now
 * what a probe of *this* Electron build actually did — one clip per container,
 * authored with a codec natural to it, loaded through `ddf-media://` in the
 * running app. Re-run it with `node test/e2e/probe-containers.mjs`; the answer
 * is build-specific and an Electron upgrade can move it. Measured 2026-08-13:
 *
 *   mp4 · m4v · mov · webm · mkv      decoded
 *   avi (H.264 and rawvideo alike)    DEMUXER_ERROR_COULD_NOT_OPEN
 *   mpg · mpeg · flv · wmv            DEMUXER_ERROR_COULD_NOT_OPEN
 *   ogv                               DEMUXER_ERROR_NO_SUPPORTED_STREAMS
 *
 * Re-measured 2026-09-18, after the handler started serving `Range` requests
 * and naming its own `Content-Type`: every row above unchanged. That is the
 * one thing the wire gate could not have told us, since every clip it plays is
 * an `.mp4`.
 *
 * `ogv` is the one that is not what it looks like, and it is why the test's
 * exclusion list is shorter than this table. Its container *opens* — the failure
 * is the Theora stream inside it, which Chromium removed support for. So `ogv`
 * is not offered, but it is also not claimed to be undemuxable, because that
 * claim is false and would be a wrong premise sitting in the repo waiting to be
 * built on.
 *
 * Note also that `canPlayType` disagrees with reality in both directions here:
 * it answers `no` for `mov`, which decodes, and `maybe` for `ogv`, which does
 * not. It is not a usable oracle for this question.
 *
 * ## What this does not promise
 *
 * An extension is a hint about a container, and a container says nothing about
 * the codec inside it. An `.mp4` holding HEVC in a build without the licensed
 * decoder fails exactly like an AVI does — and an `.mkv` is the widest gap of
 * all, since Matroska routinely carries codecs Chromium has no decoder for. So
 * this list makes the common mistake harder to make; it is not a guarantee, and
 * it is not a substitute for the failed-cue path. `engine.ts` reaping a failed
 * source into an operator-visible banner is what actually covers the general
 * case, and the wire gate grades it.
 */
export const PICKER_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];

/**
 * The `Content-Type` `ddf-media://` reports for a file, by extension.
 *
 * ## Why the handler has to own this now
 *
 * It did not use to. The handler fetched bytes with `net.fetch` over a
 * `file://` URL and passed that response's headers through, so Chromium's own
 * extension-to-MIME table supplied the type and nothing here had to know one.
 * Serving a byte range means building the `Response` from a raw
 * `createReadStream`, and a raw stream carries no headers at all — so the type
 * has to come from somewhere, and the somewhere is here.
 *
 * ## Why one map and not two
 *
 * **The `200` path and the `206` path must report the same type for the same
 * file.** Two derivations that agree today drift apart the moment one of them
 * is edited, and the disagreement would not show up as an error: it would show
 * up as a clip that plays when it is loaded whole and fails when it is seeked,
 * or on some containers and not others, which is a defect that reads as
 * flakiness. Both paths read this function, so there is one answer per file and
 * no way for them to differ.
 *
 * ## Where the values come from
 *
 * `mp4` and `m4v` are read out of this Electron build itself: Chromium's
 * extension table carries the entry `mp4,m4v` against `video/mp4`, which is
 * visible in the shipped binary —
 *
 *     strings -a 'node_modules/electron/dist/Electron.app/Contents/Frameworks/\
 *       Electron Framework.framework/Versions/A/Electron Framework' | grep -n 'mp4,m4v'
 *
 * — and `wire.mjs` confirmed it end to end: run against the *pre-fix* handler,
 * which took its type from `net.fetch`, the gate's Content-Type check read back
 * `video/mp4` for an `.mp4`, which is the same answer this table gives. So
 * those two are labelled exactly as they were before this handler served
 * ranges.
 *
 * `mov`, `webm` and `mkv` were reasoned rather than measured when this map was
 * first written — the standard types for those containers, with `video/webm`
 * in Chromium's own extension table and the other two coming from macOS's
 * `UTType` mapping — and every clip the wire gate plays is an `.mp4`, so
 * nothing else in the repo could have caught a wrong one. `probe-containers.mjs`
 * now reads the `Content-Type` the handler actually served alongside the decode
 * verdict it already reported, each file pushed through the real picker seam.
 * Measured 2026-09-18, on this build, through this handler:
 *
 *   mp4 · m4v    video/mp4           decoded   (the positive control)
 *   mov          video/quicktime     decoded
 *   webm         video/webm          decoded
 *   mkv          video/x-matroska    decoded
 *
 * Every value this map already claimed, confirmed; **nothing changed**. What is
 * new is the second half of each row — those three had never been watched serve
 * *and* decode through this handler, and now they have.
 *
 * Be exact about what that settles. The type in the middle column is this map's
 * own answer echoed back, so the run does not independently establish that
 * `video/quicktime` is the *correct* label for a `.mov`; what it establishes is
 * that the label this map hands out does not stop the container decoding, which
 * is the only way a wrong one could hurt here. `<video src=…>` playback does
 * not gate on the declared type — Chromium sniffs the container and hands it to
 * ffmpeg, which is also why `canPlayType` answers `no` for `mov` while `mov`
 * decodes — and that is now measured rather than argued: in the same run the
 * non-picker rows are all served the `application/octet-stream` fallback and
 * `ogv` still opens its container under it, failing on the missing Theora codec
 * and not on the label, while a deliberate mutation of this map's `mp4` entry
 * to `video/x-mutation` decoded anyway and was caught by the control rather
 * than by the demuxer. The type is a label; a wrong one produces the same demux
 * failure a wrong extension always did.
 *
 * If a container does stop decoding after a change here, this map is the first
 * place to look and `probe-containers.mjs` is the instrument that settles it.
 * The answer is build-specific and an Electron upgrade can move it.
 *
 * The fallback is deliberately `application/octet-stream` and deliberately not
 * a guess at a video type. Nothing outside `PICKER_EXTENSIONS` reaches the
 * handler — `servableLibraryFile` enforces that list — so a file landing on the
 * fallback means an extension was added to the picker and not here, and
 * "unknown bytes" is the honest answer to that, not `video/mp4`.
 * `mediaFormats.test.ts` grades that the two lists have not drifted.
 *
 * The one place the fallback is reached on purpose is `probe-containers.mjs`,
 * which pushes `avi`, `mpg`, `ogv` and friends through the picker *seam* and so
 * past the filter that would never offer them. Those rows reading
 * `application/octet-stream` in its table is this line working, not a defect,
 * and the probe prints a note saying so.
 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

/** What an extension with no entry above is labelled. Not a video type, on purpose. */
export const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

/**
 * The `Content-Type` for a path, decided by its extension alone.
 *
 * Extension alone, because that is all the handler has: reading the container
 * to sniff it would mean opening the file twice and would still be a guess
 * Chromium makes better itself. A wrong extension is a wrong label and then a
 * demux failure, which is the same outcome it has always had.
 */
export function mediaContentType(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return UNKNOWN_CONTENT_TYPE;
  const extension = path.slice(lastDot + 1).toLowerCase();
  return MEDIA_CONTENT_TYPES[extension] ?? UNKNOWN_CONTENT_TYPE;
}
