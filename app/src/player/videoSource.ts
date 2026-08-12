import type { FrameSource } from './engine'

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

function fileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const encoded = normalized
    .split('/')
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/')

  if (encoded.startsWith('//')) return `file://${encoded.slice(2)}`
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/** A detached, muted video decoder that satisfies the player's frame-source contract. */
export class VideoSource implements FrameSource {
  private readonly video: HTMLVideoElement
  private readyValue = false
  private failedValue = false
  private disposed = false
  private frameCallbackId: number | null = null

  private readonly onError = (): void => {
    if (!this.disposed) this.failedValue = true
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
  // `HAVE_CURRENT_DATA` means there is decoded data for the current position,
  // which is precisely the condition `draw` needs. It is the floor, not the
  // ceiling.
  private readonly onData = (): void => {
    if (this.disposed) return
    this.markReadyFromElement()
  }

  constructor(path: string) {
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.loop = true
    this.video.preload = 'auto'
    this.video.addEventListener('error', this.onError)
    this.video.addEventListener('loadeddata', this.onData)
    this.video.addEventListener('canplay', this.onData)

    if (path.trim().length === 0) {
      this.failedValue = true
      return
    }

    try {
      this.video.src = fileUrl(path)
      this.video.load()
      this.requestDecodedFrame()
    } catch {
      this.failedValue = true
    }
  }

  get ready(): boolean {
    return this.readyValue
  }

  get failed(): boolean {
    return this.failedValue
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
    if (this.disposed || this.failedValue) return
    void this.video.play().catch((error: unknown) => {
      if (this.disposed) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.failedValue = true
    })
  }

  pause(): void {
    if (!this.disposed) this.video.pause()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

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

    if (this.readyValue && !this.failedValue) {
      const rect = coverRect(this.video.videoWidth, this.video.videoHeight, width, height)
      if (rect.width > 0 && rect.height > 0) {
        try {
          context.drawImage(this.video, rect.x, rect.y, rect.width, rect.height)
        } catch {
          this.failedValue = true
        }
      }
    }
    context.restore()
  }

  private hasVideoFrameCallbacks(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function'
  }

  private requestDecodedFrame(): void {
    if (!this.hasVideoFrameCallbacks() || this.disposed) return
    this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
      this.frameCallbackId = null
      if (!this.markReadyFromElement()) this.requestDecodedFrame()
    })
  }

  private markReadyFromElement(): boolean {
    if (this.disposed || this.failedValue || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false
    }
    this.readyValue = true
    return true
  }
}
