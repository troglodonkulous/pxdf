import type { FrameSource } from './engine'
import { mediaUrl } from './mediaUrl'
import { SourceReadiness } from './sourceReadiness'
import type { Rotation } from '../render/geometry'

export interface DrawRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const EMPTY_RECT: DrawRect = { x: 0, y: 0, width: 0, height: 0 }

/** Centre-cropped cover-fit geometry for a source drawn into a destination. */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): DrawRect {
  if (
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    !Number.isFinite(dstW) ||
    !Number.isFinite(dstH) ||
    srcW <= 0 ||
    srcH <= 0 ||
    dstW <= 0 ||
    dstH <= 0
  ) {
    return EMPTY_RECT
  }

  const scale = Math.max(dstW / srcW, dstH / srcH)
  const width = srcW * scale
  const height = srcH * scale
  return {
    x: (dstW - width) / 2,
    y: (dstH - height) / 2,
    width,
    height,
  }
}

export function rotatedTargetSize(width: number, height: number, rotation: Rotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height }
}

/** A detached, muted video decoder that satisfies the player's frame-source contract. */
export class VideoSource implements FrameSource {
  private readonly video: HTMLVideoElement
  private readonly rotation: Rotation
  /** Ready / failed / disposed, and the ordering between them. */
  private readonly state = new SourceReadiness()
  private frameCallbackId: number | null = null

  private readonly onError = (): void => {
    this.state.fail()
  }

  // Readiness has two independent signals on purpose, and neither gates the
  // other. `requestVideoFrameCallback` is the precise one — it fires when a
  // frame has actually been presented — but these elements are deliberately
  // detached from the document, and a detached element may never present a
  // frame to a compositor that is not drawing it. Gating the media events
  // behind "rVFC exists" would therefore make `ready` depend on an rVFC that
  // may never fire in exactly the configuration this app uses, and a source
  // that never reports ready is a cue that never goes live: GO would appear to
  // do nothing, for ever, with no error anywhere.
  //
  // Both signals land in `markReadyFromElement`, which owns the threshold.
  private readonly onData = (): void => {
    this.markReadyFromElement()
  }

  constructor(path: string, rotation: Rotation = 0) {
    this.rotation = rotation
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.loop = true
    this.video.preload = 'auto'
    this.video.addEventListener('error', this.onError)
    this.video.addEventListener('loadeddata', this.onData)
    this.video.addEventListener('canplay', this.onData)

    if (path.trim().length === 0) {
      this.state.fail()
      return
    }

    try {
      // Before `src`, not after: the request mode is fixed when the load
      // starts, and setting `crossOrigin` afterwards would apply to the next
      // load rather than this one.
      //
      // This is not optional and it is not hygiene. `ddf-media://` is a
      // different origin from the page however the page was served, so without
      // a CORS-mode fetch the media taints any canvas it is drawn into and the
      // render loop's `getImageData` throws on every frame — see the long note
      // in `electron/main.ts`. It only works paired with `corsEnabled` on the
      // scheme; alone it makes the element fail to load at all.
      this.video.crossOrigin = 'anonymous'
      // Never `file://`. The page is served over `file://` when packaged and
      // over `http://` under the dev server, and Chromium blocks a `file://`
      // subresource from the second — see `mediaUrl.ts`.
      this.video.src = mediaUrl(path)
      this.video.load()
      this.requestDecodedFrame()
    } catch {
      this.state.fail()
    }
  }

  get ready(): boolean {
    return this.state.ready
  }

  get failed(): boolean {
    return this.state.failed
  }

  /**
   * Mark the media unplayable from outside the element.
   *
   * `draw` only sees the failures `drawImage` itself raises, and the step after
   * it — reading the composited pixels back off the work canvas — fails for
   * reasons that belong to this source just as much. A tainted canvas is a
   * property of what was drawn into it.
   *
   * The engine has exactly one channel for that news, `failed`, and it does the
   * right things with it: an error the operator can read, and black on the
   * floor rather than a held frame of a cue that is broken. Without this seam
   * the render loop rediscovers the same dead source sixty times a second for
   * ever, with nothing on screen to say so — which is precisely how the taint
   * defect stayed invisible.
   */
  fail(): void {
    this.state.fail()
  }

  get positionMs(): number {
    const seconds = this.video.currentTime
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0
  }

  get mediaDurationMs(): number | null {
    const seconds = this.video.duration
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null
  }

  play(): void {
    if (this.state.disposed || this.state.failed) return
    void this.video.play().catch((error: unknown) => {
      // An `AbortError` means a newer load or pause superseded this play, which
      // is ordinary during a cue change and not a failure. `state.fail()`
      // ignores everything after teardown on its own.
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.state.fail()
    })
  }

  pause(): void {
    if (!this.state.disposed) this.video.pause()
  }

  dispose(): void {
    if (!this.state.dispose()) return

    if (this.frameCallbackId !== null && this.hasVideoFrameCallbacks()) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId)
      this.frameCallbackId = null
    }
    this.video.removeEventListener('error', this.onError)
    this.video.removeEventListener('loadeddata', this.onData)
    this.video.removeEventListener('canplay', this.onData)
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
    context.fillStyle = '#000000'
    context.fillRect(0, 0, width, height)

    if (this.state.ready && !this.state.failed) {
      const target = rotatedTargetSize(width, height, this.rotation)
      const rect = coverRect(this.video.videoWidth, this.video.videoHeight, target.width, target.height)
      if (rect.width > 0 && rect.height > 0) {
        context.save()
        context.translate(width / 2, height / 2)
        context.rotate((this.rotation * Math.PI) / 180)
        try {
          context.drawImage(
            this.video,
            rect.x - target.width / 2,
            rect.y - target.height / 2,
            rect.width,
            rect.height,
          )
        } catch {
          this.state.fail()
        }
        context.restore()
      }
    }
    context.restore()
  }

  private hasVideoFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function'
  }

  private requestDecodedFrame(): void {
    if (!this.hasVideoFrameCallbacks() || this.state.disposed) return
    this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
      this.frameCallbackId = null
      if (!this.markReadyFromElement()) this.requestDecodedFrame()
    })
  }

  /**
   * The one DOM read behind readiness, kept here rather than in
   * `SourceReadiness` so the threshold sits next to the constant that defines
   * it. `HAVE_CURRENT_DATA` means there is decoded data for the current
   * position, which is exactly what `draw` needs — the floor, not the ceiling.
   */
  private markReadyFromElement(): boolean {
    return this.state.observe(this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
  }
}
