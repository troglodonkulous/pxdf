import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SenderStatus } from '../electron/sidecar.js'
import { MappingScreen, type NetworkInterface } from './mapping/MappingScreen.js'
import { applyFloorSelection } from './mapping/floorSelection.js'
import { PlayScreen } from './PlayScreen.js'
import { composeFrame } from './player/compose.js'
import { decoderCensus } from './player/decoderCensus.js'
import { PlayerEngine, type EngineSnapshot } from './player/engine.js'
import { emptyShow, type Show, type ShowFloor } from './player/show.js'
import { VideoSource } from './player/videoSource.js'
import { ZOOM_FIT, zoomIn, zoomOut } from './player/zoom.js'
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
      createSource: (cue) => new VideoSource(cue.source.path, cue.rotation, { trimStartMs: cue.trimStartMs, trimEndMs: cue.trimEndMs }),
    })
  }
  const engine = engineRef.current

  const [surface, setSurface] = useState<'mapping' | 'play'>('mapping')
  const [rotation, setRotation] = useState<Rotation>(0)
  const [zoom, setZoom] = useState(ZOOM_FIT)
  const [show, setShow] = useState<Show>(INITIAL_SHOW)
  const [status, setStatus] = useState<SenderStatus>('restarting')
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(() => engine.snapshot())
  const [stats, setStats] = useState<RenderStats>({ fps: 0, passMs: 0 })

  /**
   * The NIC list and the operator's pick, held here rather than in
   * `MappingScreen`.
   *
   * They used to be that component's own `useState`, and the surface switch
   * below unmounts it, so every trip to the Player and back reset the pick to
   * `interfaces[0]` — while the sidecar stayed bound to whatever the operator
   * had actually chosen. The dropdown and the wire disagreed, silently, and
   * nothing wrote either back to the other. `floor` and `rotation` already live
   * up here for exactly this reason; the NIC was the one piece of Mapping state
   * still owned by the component that cannot survive being navigated away from.
   *
   * The list is pushed from the main process rather than fetched on mount, so a
   * cable plugged in while Mapping is on screen shows up without a round trip
   * through the Player. Same poll that suspends the sidecar when the bound
   * address goes away — one watcher, three consumers.
   */
  const [interfaces, setInterfaces] = useState<readonly NetworkInterface[]>([])
  const [localIp, setLocalIp] = useState<string>('')
  const [senderError, setSenderError] = useState<string | null>(null)

  const floor = useMemo(
    () => floorGeometry(show.floor.type, show.floor.tileCols, show.floor.tileRows),
    [show.floor.type, show.floor.tileCols, show.floor.tileRows],
  )
  const work = useMemo(() => workSize(floor, rotation, S), [floor, rotation])

  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewClipRef = useRef<HTMLDivElement>(null)
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
  useEffect(() => window.ddf.onSenderError((payload) => setSenderError(payload?.message ?? null)), [])
  useEffect(() => window.ddf.onInterfaces(setInterfaces), [])

  /*
   * What the show did, for the log.
   *
   * Keyed on primitives out of `snapshot` and never on `snapshot` itself: the
   * render loop replaces that object four times a second, so an effect
   * depending on it would write four lines a second for the life of the
   * session. These fire on the transition only.
   *
   * The sender's own transitions are not here — `main.ts` already logs status
   * changes and every banner it publishes, and it sees them whether or not a
   * renderer is alive to notice. Logging them again from this side would put
   * two lines in the file for one event and make a crash loop read as twice
   * the crash loop it is.
   */
  useEffect(() => {
    // `lastErrorLog`, not `lastError`. The banner and the log line used to be
    // the same string, which meant the log inherited a constraint that belongs
    // only to the banner — it has to be short, because an operator reads it
    // over a console mid-show. The file has no such limit and the reader of the
    // file has the opposite need, so it gets the failing path too. The two
    // fields are null and non-null together (`engine.ts`), so keying on this
    // one fires on exactly the transitions the old one did.
    if (snapshot.lastErrorLog !== null) window.ddf.log('ERROR', 'player', snapshot.lastErrorLog)
  }, [snapshot.lastErrorLog])

  useEffect(() => {
    // Logged when it appears and not when it clears. A stall that resolves is
    // the system working; the line that matters is the one whose timestamp can
    // be lined up against a glitch somebody saw on the floor.
    if (snapshot.stallWarning !== null) window.ddf.log('WARN', 'player', snapshot.stallWarning)
  }, [snapshot.stallWarning])

  useEffect(() => {
    // The show's timeline. Read through `showRef` rather than taking `show` as
    // a dependency, so this fires when the live cue changes and not when the
    // operator renames one.
    const cue = showRef.current.cues.find(({ id }) => id === snapshot.liveCueId)
    window.ddf.log(
      'INFO',
      'player',
      cue === undefined
        ? 'live: (none)'
        : `live: ${JSON.stringify(cue.name)} ${cue.source.path}`,
    )
  }, [snapshot.liveCueId])

  // The bound address is the main process's to know — it is what `mapper stream`
  // was actually launched with. Reading it once at start rather than assuming
  // `interfaces[0]` is what makes a `DDF_LOCAL_IP` set in the environment, or
  // restored from settings, show up in the dropdown as the truth instead of
  // being silently contradicted by it.
  useEffect(() => {
    void window.ddf.getLocalIp().then(setLocalIp)
  }, [])

  const selectInterface = async (address: string): Promise<void> => {
    await window.ddf.setLocalIp(address)
    setLocalIp(address)
  }

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
    // The other two thirds of a composed frame, accumulated the same way and
    // reported to the main process rather than to React. The on-screen readout
    // keeps saying "one-pass" and means it; these go to the log, where the
    // question "what did a frame actually cost during the job" can still be
    // asked the next morning. See `electron/renderStats.ts`.
    let sampledDrawTime = 0
    let sampledReadbackTime = 0
    let sampledDrawMax = 0
    let sampledReadbackMax = 0
    let sampledPassMax = 0

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
      // All three timings are non-null together or null together, so one guard
      // covers them — and a failed frame contributes to none of the six
      // accumulators rather than to some of them.
      if (composed.passMs !== null && composed.drawMs !== null && composed.readbackMs !== null) {
        sampledPassTime += composed.passMs
        sampledDrawTime += composed.drawMs
        sampledReadbackTime += composed.readbackMs
        if (composed.passMs > sampledPassMax) sampledPassMax = composed.passMs
        if (composed.drawMs > sampledDrawMax) sampledDrawMax = composed.drawMs
        if (composed.readbackMs > sampledReadbackMax) sampledReadbackMax = composed.readbackMs
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
      // content when it is in Master/IR mode (in slave mode it would hold its
      // last frame instead, same as 2 and 3), so there is no branch here that
      // may skip it either way.
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
        // Sums and maxima, not averages: the main process folds four of these a
        // second into a minute and must be able to weight them by how many
        // frames each one saw. The decoder census is read here rather than at
        // either creation site because this is the only place in the app that
        // runs on a clock — a push from `VideoSource`'s constructor would put an
        // IPC send on the cue-arming path.
        const census = decoderCensus()
        window.ddf.renderStats({
          composes: sampledPasses,
          drawMsTotal: sampledDrawTime,
          readbackMsTotal: sampledReadbackTime,
          passMsTotal: sampledPassTime,
          drawMsMax: sampledDrawMax,
          readbackMsMax: sampledReadbackMax,
          passMsMax: sampledPassMax,
          decodersLive: census.live,
          decodersPeak: census.peak,
          decodersOpened: census.opened,
        })
        sampleStartedAt = now
        sampledFrames = 0
        sampledPasses = 0
        sampledPassTime = 0
        sampledDrawTime = 0
        sampledReadbackTime = 0
        sampledDrawMax = 0
        sampledReadbackMax = 0
        sampledPassMax = 0
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
    const previewClip = previewClipRef.current
    const previewContainer = previewContainerRef.current
    if (surface !== 'play' || previewCanvas === null || previewClip === null || previewContainer === null) return

    // The canvas element always holds a floor-native framebuffer (see the
    // layout effect above) — rotation never touches that pixel data, only
    // this element's on-screen box. `previewContainer`'s box stays
    // floor-shaped regardless of rotation (an empty div, sized only to
    // reserve layout space), so at 90/270 the box a rotated floor needs to
    // sit in is portrait where the container is landscape or vice versa.
    // This fits that (rotated) box inside the container the way `object-fit:
    // contain` would, then rotates the floor-shaped canvas into it — the
    // same way a landscape photo is shown, uncropped, in a portrait frame.
    //
    // `previewClip` is what makes zoom actually stay "within its center
    // panel": it tracks `previewContainer`'s box exactly (unrotated,
    // unscaled) and clips with `overflow: hidden`. The canvas itself is
    // `position: fixed`, mounted once outside the surface switch (see the
    // canvas's own comment below) — a fixed element ignores every ancestor's
    // `overflow`, including `.preview-well`'s, so clipping has to come from
    // an element the canvas is an actual DOM child of. `previewClip` is that
    // element; the canvas centers on it with plain `50%` + the same
    // translate/rotate transform as before, since the clip box's own size
    // already equals the container's.
    const positionPreview = (): void => {
      const bounds = previewContainer.getBoundingClientRect()
      previewClip.style.left = `${bounds.left}px`
      previewClip.style.top = `${bounds.top}px`
      previewClip.style.width = `${bounds.width}px`
      previewClip.style.height = `${bounds.height}px`

      const swapped = rotation === 90 || rotation === 270
      const boxW = swapped ? floor.heightPx : floor.widthPx
      const boxH = swapped ? floor.widthPx : floor.heightPx
      const fitScale = Math.min(bounds.width / boxW, bounds.height / boxH)
      const fittedW = boxW * fitScale * zoom
      const fittedH = boxH * fitScale * zoom
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
  }, [surface, floor.widthPx, floor.heightPx, rotation, zoom])

  useEffect(() => {
    if (surface !== 'play') return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        setZoom(zoomIn)
      } else if (event.metaKey && event.key === '-') {
        event.preventDefault()
        setZoom(zoomOut)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [surface])

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
          interfaces={interfaces}
          localIp={localIp}
          senderError={senderError}
          selectInterface={selectInterface}
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
          senderError={senderError}
          snapshot={snapshot}
          stats={stats}
          engine={engine}
          previewContainerRef={previewContainerRef}
          applyShow={applyShow}
          refreshSnapshot={refreshSnapshot}
          setSurface={setSurface}
          zoom={zoom}
          onZoomIn={() => setZoom(zoomIn)}
          onZoomOut={() => setZoom(zoomOut)}
          onZoomFit={() => setZoom(ZOOM_FIT)}
          onZoomSet={setZoom}
        />
      )}
      {/*
        Mounted once, here, and never unmounted — the render loop bails before
        `writeFrame` if this ref is null, and this element used to live inside
        Play's JSX. With the app launching on Mapping that would mean nothing
        reaches the sidecar at all until Open Player is clicked, and silence is
        what makes controller 1 revert to the vendor's own content in Master/IR
        mode (in slave mode it would hold its last frame instead). `surface`
        toggles its visibility in CSS; `PlayScreen` only supplies a container to
        position it into.

        The label is derived rather than written down. It said "80 by 40" while
        the floor was a constant; now that geometry is a runtime variable a
        fixed string silently stops being true the first time an operator picks
        10 x 12, and the one reader who cannot see the discrepancy is the
        screen-reader user relying on it.
      */}
      {/*
        The clip window `positionPreview` tracks onto `previewContainer`'s
        box. `overflow: hidden` here is real, unlike a rule on `.preview-well`
        would be against a `position: fixed` descendant — the canvas below is
        an actual DOM child of this element, so zooming past "fit" is
        genuinely contained to the panel instead of drawing over the cue
        stack and inspector.
      */}
      <div
        ref={previewClipRef}
        className={`preview-clip${surface === 'play' ? ' is-visible' : ''}`}
      >
        <canvas
          ref={previewCanvasRef}
          className="persistent-preview-canvas"
          width={floor.widthPx}
          height={floor.heightPx}
          aria-label={`${floor.widthPx} by ${floor.heightPx} pixel floor framebuffer`}
        />
      </div>
    </>
  )
}
