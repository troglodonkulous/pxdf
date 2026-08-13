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
