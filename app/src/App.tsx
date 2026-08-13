import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SenderStatus } from '../electron/sidecar.js'
import { MappingScreen } from './mapping/MappingScreen.js'
import { applyFloorSelection } from './mapping/floorSelection.js'
import { PlayScreen } from './PlayScreen.js'
import { composeFrame } from './player/compose.js'
import { PlayerEngine, type EngineSnapshot } from './player/engine.js'
import { emptyShow, type Show, type ShowFloor } from './player/show.js'
import { VideoSource } from './player/videoSource.js'
import { floorGeometry, SHOP_RIG, workSize, type Rotation } from './render/geometry.js'
import { blackFrame } from './render/onePass.js'

const S = 8
const INITIAL_SHOW = emptyShow(
  { type: SHOP_RIG.type, tileCols: SHOP_RIG.tileCols, tileRows: SHOP_RIG.tileRows },
  'Untitled show',
)

interface RenderStats {
  readonly fps: number
  readonly passMs: number
}

function rgbToPreview(rgb: Uint8Array, image: ImageData): void {
  const rgba = image.data
  let source = 0
  let target = 0
  while (source < rgb.length) {
    rgba[target] = rgb[source]
    rgba[target + 1] = rgb[source + 1]
    rgba[target + 2] = rgb[source + 2]
    rgba[target + 3] = 255
    source += 3
    target += 4
  }
}

export function App() {
  const engineRef = useRef<PlayerEngine<VideoSource> | null>(null)
  if (engineRef.current === null) {
    engineRef.current = new PlayerEngine({
      show: INITIAL_SHOW,
      createSource: (cue) => new VideoSource(cue.source.path, cue.rotation),
    })
  }
  const engine = engineRef.current

  const [surface, setSurface] = useState<'mapping' | 'play'>('mapping')
  const [rotation, setRotation] = useState<Rotation>(0)
  const [show, setShow] = useState<Show>(INITIAL_SHOW)
  const [status, setStatus] = useState<SenderStatus>('restarting')
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(() => engine.snapshot())
  const [stats, setStats] = useState<RenderStats>({ fps: 0, passMs: 0 })

  const floor = useMemo(
    () => floorGeometry(show.floor.type, show.floor.tileCols, show.floor.tileRows),
    [show.floor.type, show.floor.tileCols, show.floor.tileRows],
  )
  const work = useMemo(() => workSize(floor, rotation, S), [floor, rotation])

  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)
  const wireBufferRef = useRef(new Uint8Array(floor.frameBytes))
  const previewBufferRef = useRef(new Uint8Array(floor.frameBytes))
  const blackFrameRef = useRef(blackFrame(floor))
  const previewImageRef = useRef<ImageData | null>(null)
  const showRef = useRef<Show>(INITIAL_SHOW)
  const floorRef = useRef(floor); floorRef.current = floor
  const workRef = useRef(work); workRef.current = work
  const passRef = useRef({ rotation, mirrorX: false, mirrorY: false, s: S })
  passRef.current = { rotation, mirrorX: false, mirrorY: false, s: S }

  useEffect(() => window.ddf.onStatus(setStatus), [])

  /**
   * Buffers follow the floor, in their own effect keyed on the sizes that
   * actually change them.
   *
   * `frameBytes` moves on a Type/Width/Height change and not on Rotation, which
   * is the same distinction `Sidecar.writeFrame`'s byteLength gate makes on the
   * other side of the IPC boundary — Rotation is a presentation transform and
   * the framebuffer it produces is the same size.
   *
   * `useLayoutEffect`, not `useEffect`, and that is the whole reason this is
   * called out. `floorRef.current` is updated during render, so between the
   * commit that changes the floor and a passive effect flushed after paint,
   * `requestAnimationFrame` can fire with the new geometry and the old, smaller
   * buffer. Nothing corrupts — an undersized write into a typed array drops
   * silently and `Sidecar` discards the wrong-length frame — but the floor goes
   * dark for those frames for no reason anyone would find. A layout effect runs
   * before paint, so the window does not exist.
   */
  useLayoutEffect(() => {
    wireBufferRef.current = new Uint8Array(floor.frameBytes)
    previewBufferRef.current = new Uint8Array(floor.frameBytes)
    blackFrameRef.current = blackFrame(floor)
    const previewContext = previewCanvasRef.current?.getContext('2d')
    previewImageRef.current = previewContext?.createImageData(floor.widthPx, floor.heightPx) ?? null
  }, [floor.frameBytes, floor.widthPx, floor.heightPx])

  useEffect(() => {
    const previewCanvas = previewCanvasRef.current
    const previewContext = previewCanvas?.getContext('2d')
    if (previewCanvas === null || previewContext === null || previewContext === undefined) return

    const workCanvas = document.createElement('canvas')
    const initialWork = workRef.current
    workCanvas.width = initialWork.width
    workCanvas.height = initialWork.height
    const workContext = workCanvas.getContext('2d', { willReadFrequently: true })
    if (workContext === null) return

    let animationFrame = 0
    let sampleStartedAt = performance.now()
    let sampledFrames = 0
    let sampledPasses = 0
    let sampledPassTime = 0

    // Composition is the one step here that touches a decoder, a canvas and
    // cross-origin media, so it is the one that is allowed to fail — and
    // `composeFrame` guarantees it fails by returning black rather than by
    // throwing. That guarantee is what makes the `writeFrame` below
    // unconditional. See `player/compose.ts` for what happened without it.
    const compose = (
      source: VideoSource,
      master: number,
      into: Uint8Array,
    ): Uint8Array => {
      const currentFloor = floorRef.current
      const currentWork = workRef.current
      const composed = composeFrame({
        source,
        context: workContext,
        workWidth: currentWork.width,
        workHeight: currentWork.height,
        floor: currentFloor,
        pass: { ...passRef.current, master },
        into,
        fallback: blackFrameRef.current,
      })
      if (composed.passMs !== null) {
        sampledPassTime += composed.passMs
        sampledPasses += 1
      }
      return composed.bytes
    }

    const render = (now: number): void => {
      // Schedule first: a decoder or preview failure must not stop future writes.
      animationFrame = requestAnimationFrame(render)
      const currentFloor = floorRef.current
      const currentWork = workRef.current
      if (workCanvas.width !== currentWork.width) workCanvas.width = currentWork.width
      if (workCanvas.height !== currentWork.height) workCanvas.height = currentWork.height

      const tick = engine.tick()

      // The floor. Exactly one write per animation frame, on every path —
      // stopping the send is what makes controller 1 revert to the vendor's own
      // content, so there is no branch here that may skip it.
      const wireBytes = tick.wire.kind === 'black'
        ? blackFrameRef.current
        : compose(tick.wire.source, tick.master, wireBufferRef.current)
      window.ddf.writeFrame(wireBytes)

      // The on-screen floor preview. Live mode reuses exactly what was sent.
      let screenBytes: Uint8Array
      if (tick.screen === tick.wire) {
        screenBytes = wireBytes
      } else if (tick.screen.kind === 'black') {
        screenBytes = blackFrameRef.current
      } else {
        screenBytes = compose(tick.screen.source, tick.master, previewBufferRef.current)
      }
      let previewImage = previewImageRef.current
      if (previewImage === null
        || previewImage.width !== currentFloor.widthPx
        || previewImage.height !== currentFloor.heightPx) {
        previewImage = previewContext.createImageData(currentFloor.widthPx, currentFloor.heightPx)
        previewImageRef.current = previewImage
      }
      rgbToPreview(screenBytes, previewImage)
      previewContext.putImageData(previewImage, 0, 0)

      sampledFrames += 1
      const sampleDuration = now - sampleStartedAt
      if (sampleDuration >= 250) {
        setStats({
          fps: sampledFrames * 1_000 / sampleDuration,
          passMs: sampledPasses === 0 ? 0 : sampledPassTime / sampledPasses,
        })
        setSnapshot(engine.snapshot())
        sampleStartedAt = now
        sampledFrames = 0
        sampledPasses = 0
        sampledPassTime = 0
      }
    }

    animationFrame = requestAnimationFrame(render)
    // Only the loop is torn down here. Disposing the engine would be wrong:
    // `StrictMode` mounts, cleans up and remounts, while the engine lives in a
    // ref that survives all three — so the remounted loop would be driving an
    // engine whose decoders had already been released. There is one root and
    // one engine for the life of the window, and `main.ts` already writes a
    // black frame when the last window closes.
    return () => cancelAnimationFrame(animationFrame)
  }, [engine])

  useLayoutEffect(() => {
    const previewCanvas = previewCanvasRef.current
    const previewContainer = previewContainerRef.current
    if (surface !== 'play' || previewCanvas === null || previewContainer === null) return

    // The canvas element always holds a floor-native framebuffer (see the
    // layout effect above) — rotation never touches that pixel data, only
    // this element's on-screen box. `previewContainer`'s box stays
    // floor-shaped regardless of rotation (an empty div, sized only to
    // reserve layout space), so at 90/270 the box a rotated floor needs to
    // sit in is portrait where the container is landscape or vice versa.
    // This fits that (rotated) box inside the container the way `object-fit:
    // contain` would, then rotates the floor-shaped canvas into it — the
    // same way a landscape photo is shown, uncropped, in a portrait frame.
    const positionPreview = (): void => {
      const bounds = previewContainer.getBoundingClientRect()
      const swapped = rotation === 90 || rotation === 270
      const boxW = swapped ? floor.heightPx : floor.widthPx
      const boxH = swapped ? floor.widthPx : floor.heightPx
      const fitScale = Math.min(bounds.width / boxW, bounds.height / boxH)
      const fittedW = boxW * fitScale
      const fittedH = boxH * fitScale
      previewCanvas.style.left = `${bounds.left + bounds.width / 2}px`
      previewCanvas.style.top = `${bounds.top + bounds.height / 2}px`
      previewCanvas.style.width = `${swapped ? fittedH : fittedW}px`
      previewCanvas.style.height = `${swapped ? fittedW : fittedH}px`
      previewCanvas.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`
    }

    positionPreview()
    const observer = new ResizeObserver(positionPreview)
    observer.observe(previewContainer)
    window.addEventListener('resize', positionPreview)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionPreview)
    }
  }, [surface, floor.widthPx, floor.heightPx, rotation])

  const refreshSnapshot = (): void => setSnapshot(engine.snapshot())

  const applyShow = (next: Show): void => {
    showRef.current = next
    engine.setShow(next)
    setShow(next)
    refreshSnapshot()
  }

  const changeFloor = async (
    patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
  ): Promise<void> => {
    const next = applyFloorSelection(show.floor, patch)
    await window.ddf.setFloor(next)
    applyShow({ ...show, floor: next })
  }

  return (
    <>
      {surface === 'mapping' ? (
        <MappingScreen
          floor={floor}
          rotation={rotation}
          status={status}
          changeFloor={changeFloor}
          setRotation={setRotation}
          setSurface={setSurface}
        />
      ) : (
        <PlayScreen
          show={show}
          showRef={showRef}
          floor={floor}
          status={status}
          snapshot={snapshot}
          stats={stats}
          engine={engine}
          previewContainerRef={previewContainerRef}
          applyShow={applyShow}
          refreshSnapshot={refreshSnapshot}
          setSurface={setSurface}
        />
      )}
      {/*
        Mounted once, here, and never unmounted — the render loop bails before
        `writeFrame` if this ref is null, and this element used to live inside
        Play's JSX. With the app launching on Mapping that would mean nothing
        reaches the sidecar at all until Open Player is clicked, and silence is
        what makes controller 1 revert to the vendor's own content. `surface`
        toggles its visibility in CSS; `PlayScreen` only supplies a container to
        position it into.

        The label is derived rather than written down. It said "80 by 40" while
        the floor was a constant; now that geometry is a runtime variable a
        fixed string silently stops being true the first time an operator picks
        10 x 12, and the one reader who cannot see the discrepancy is the
        screen-reader user relying on it.
      */}
      <canvas
        ref={previewCanvasRef}
        className={`persistent-preview-canvas${surface === 'play' ? ' is-visible' : ''}`}
        width={floor.widthPx}
        height={floor.heightPx}
        aria-label={`${floor.widthPx} by ${floor.heightPx} pixel floor framebuffer`}
      />
    </>
  )
}
