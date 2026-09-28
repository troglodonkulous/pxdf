import { openDecoder } from './decoderCensus'
import { coverRect } from './videoSource'
import { mediaUrl } from './mediaUrl'

/**
 * A cue's thumbnail, grabbed the same way `probeDurationMs` reads a duration:
 * a throwaway, detached `<video>` that the caller owns disposing, polled
 * rather than listened to end to end.
 *
 * ## What the timestamp does and does not mean
 *
 * `captureThumbnail` takes an optional `timestampMs`, defaulting to `0` — the
 * first frame. That is the whole contract. `trimStartMs` is being built on a
 * different branch and does not exist on this one; this module makes no claim
 * about "the cue's in-point" and nothing here should be read as one. When
 * trim lands, whatever calls this passes `cue.trimStartMs` and this file
 * changes nothing — it already takes a timestamp.
 *
 * ## Never written to the show file
 *
 * The caller keeps the result in a `Map` in memory, one per cue, for the
 * life of the window. `show.ts`'s file format forbids exactly this kind of
 * payload — a show file holding a base64 frame is a project-format leak, the
 * same shape `docs/APP-PLAN.md` rules out for the show file generally.
 */

export const THUMB_WIDTH = 40
export const THUMB_HEIGHT = 24

/**
 * Where in the clip to seek before drawing, clamped to something the element
 * can actually seek to.
 *
 * Pure and DOM-free on purpose — it is the one piece of this file's logic
 * that is not "ask Chromium to decode a frame", so it is the one piece a
 * `vitest` run can grade without a real decoder. `duration - 0.01` rather
 * than `duration` because seeking to the exact end of some containers lands
 * on the last frame *before* it decodes, which is a `seeked` event that never
 * fires — see the identical margin in the same situation nowhere else in this
 * codebase; this is the first place that seeks past a known duration at all.
 */
export function clampSeekSeconds(timestampMs: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  const requested = Math.max(0, Number.isFinite(timestampMs) ? timestampMs : 0) / 1_000
  return Math.min(requested, Math.max(0, durationSeconds - 0.01))
}

export interface ThumbnailOptions {
  readonly timeoutMs?: number
}

const THUMBNAIL_TIMEOUT_MS = 5_000

/**
 * Decode one frame of `path` and draw it, cover-fit, into a
 * `THUMB_WIDTH` x `THUMB_HEIGHT` canvas.
 *
 * Every exit is loud: a decode failure or a timeout rejects rather than
 * resolving with a blank canvas, so the caller can tell "no thumbnail yet"
 * from "this file will never produce one" — the same distinction
 * `probeDurationMs` makes for duration, for the same reason. `dispose`d
 * unconditionally by the caller in a `finally`, mirroring `fillDurationFromMedia`.
 */
export async function captureThumbnail(
  path: string,
  timestampMs = 0,
  options: ThumbnailOptions = {},
): Promise<HTMLCanvasElement> {
  const timeoutMs = options.timeoutMs ?? THUMBNAIL_TIMEOUT_MS
  const video = document.createElement('video')
  // The second of the app's two decoder-creation sites, and the one that fans
  // out: `PlayScreen` calls this once per cue with no concurrency limit, so
  // adding forty clips opens forty of these at once. Counted from immediately
  // after the element exists to the `finally` below, which runs on the decode
  // failure and the timeout as well as the happy path — those are exactly the
  // paths that abandon a throwaway decoder, and a census that skipped them
  // would climb for ever and invent an exhaustion. See `decoderCensus.ts`.
  const closeCensusEntry = openDecoder()
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  // Same pairing as `VideoSource`: `ddf-media://` is cross-origin to the page
  // however it was served, and without a CORS-mode fetch the frame taints the
  // canvas this draws into — see the long note in `electron/main.ts`.
  video.crossOrigin = 'anonymous'

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out reading the media')), timeoutMs)
      const fail = (): void => {
        clearTimeout(timer)
        reject(new Error('could not read the media'))
      }
      video.addEventListener('error', fail, { once: true })
      video.addEventListener('loadedmetadata', () => {
        const onSeeked = (): void => {
          clearTimeout(timer)
          video.removeEventListener('error', fail)
          resolve()
        }
        video.addEventListener('seeked', onSeeked, { once: true })
        video.currentTime = clampSeekSeconds(timestampMs, video.duration)
      }, { once: true })
      video.src = mediaUrl(path)
      video.load()
    })

    const canvas = document.createElement('canvas')
    canvas.width = THUMB_WIDTH
    canvas.height = THUMB_HEIGHT
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('could not create a thumbnail canvas')

    context.fillStyle = '#000000'
    context.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT)
    const rect = coverRect(video.videoWidth, video.videoHeight, THUMB_WIDTH, THUMB_HEIGHT)
    if (rect.width > 0 && rect.height > 0) context.drawImage(video, rect.x, rect.y, rect.width, rect.height)
    return canvas
  } finally {
    video.removeAttribute('src')
    video.load()
    closeCensusEntry()
  }
}
