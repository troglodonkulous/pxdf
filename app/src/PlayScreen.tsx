import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type * as React from 'react'
import type { SenderStatus } from '../electron/sidecar.js'
import { StatusPill } from './StatusPill.js'
import type { EngineSnapshot, PlayerEngine, PlayerMode } from './player/engine.js'
import { probeDurationMs } from './player/mediaDuration.js'
import {
  cueNameFromPath,
  formatTimecode,
  insertCue,
  moveCue,
  removeCue,
  renameCue,
  setCueRotation,
} from './player/playHelpers.js'
import { clipDurationMs, cueHoldMs, nextCueId, type Cue, type Show } from './player/show.js'
import { VideoSource } from './player/videoSource.js'
import { captureThumbnail } from './player/thumbnail.js'
import { createTaskPool } from './player/taskPool.js'
import { parseZoomPercent, zoomPercentText } from './player/zoom.js'
import type { FloorGeometry } from './render/geometry.js'
import { usePopoverEscape } from './popoverEscape.js'

interface RenderStats {
  readonly fps: number
  readonly passMs: number
}

const TIMELINE_SEGMENTS = 40
const MIN_PANEL_WIDTH = 180
const MAX_PANEL_WIDTH = 420

/**
 * How many throwaway decoders each per-cue fan-out may hold open at once.
 *
 * Four, and the number is measured rather than guessed. Running all 71 clips
 * of the job library through the `captureThumbnail` shape — metadata, seek,
 * `drawImage`, `toDataURL` — at a range of pool widths, on this Mac, Electron
 * 43.4.0, 2026-09-19:
 *
 *     width    slowest single task    wall time for all 71
 *         1                 132 ms                 4355 ms
 *         2                 192 ms                 3555 ms
 *         4                 267 ms                 3099 ms
 *         6                 323 ms                 3041 ms
 *         8                 937 ms                 4575 ms
 *        16                 986 ms                 3581 ms
 *        71                3314 ms                 3315 ms
 *
 * The wall time is flat across every width: the set is bounded by how much
 * decoding there is to do, not by how much of it runs at once. **Concurrency
 * buys nothing here and costs per-task latency**, and per-task latency is what
 * actually failed — `captureThumbnail` carries a 5 s deadline that starts when
 * the task is created, so a task Chromium parks behind seventy others spends
 * its whole deadline waiting for a decoder it was never going to get. In the
 * app, with the duration fan-out, 71 `toDataURL` calls and 71 React renders on
 * the same main thread, 65 of 71 crossed that deadline.
 *
 * Four rather than one because adding a folder must stay responsive and four
 * keeps four rows filling at a time for the same total cost; four rather than
 * eight because eight is where the slowest task starts climbing (937 ms) for
 * no gain in wall time. At four the slowest task has roughly nineteen times
 * its deadline in hand, which is the margin that stops this being a race at
 * all.
 *
 * Two pools rather than one, so neither fan-out can starve the other: a
 * thumbnail sitting on its 5 s deadline must not hold up the duration probe
 * that decides whether Loop on that cue can ever advance. The ceiling this
 * puts on throwaway decoders is therefore eight, plus the engine's own three
 * slots for live, pending and preview — eleven against a measured `peak=142`
 * before it.
 */
const THROWAWAY_DECODER_LIMIT = 4

/**
 * Module scope, not a `useRef`: there is one Play surface per window, and the
 * limit is a property of the window's decoder pool rather than of a React
 * component instance. A pool rebuilt on remount would briefly allow twice the
 * work it exists to bound.
 */
const THUMBNAIL_POOL = createTaskPool(THROWAWAY_DECODER_LIMIT)
const DURATION_POOL = createTaskPool(THROWAWAY_DECODER_LIMIT)

/**
 * A cue row's thumbnail cell, in its three states.
 *
 * The third state is the point. Before this, a thumbnail that never arrived
 * and a thumbnail still being decoded were the same empty well, and
 * `PlayScreen` swallowed the rejection into `.catch(() => {})` — so 65 blank
 * squares out of 71 looked exactly like 65 squares that were still coming, and
 * did for a month. `CLAUDE.md`: silence must be distinguishable from success.
 * The marker is the operator's channel and the `WARN` line beside it is the
 * log's; neither replaces the other, because the operator reads one of them
 * mid-show and the other the morning after.
 *
 * Still `aria-hidden` in all three states. The row is an `option` in a
 * listbox, and its accessible name is the cue's name — putting a second
 * labelled node inside would change what a screen reader calls the row, which
 * is a worse trade than it looks for a decorative 40 x 24 cell.
 */
function CueThumb({ url, failure }: {
  readonly url: string | undefined
  readonly failure: string | undefined
}): ReactNode {
  if (url !== undefined) {
    return (
      <span className="cue-thumb" aria-hidden="true">
        <img src={url} alt="" width={40} height={24} />
      </span>
    )
  }
  if (failure !== undefined) {
    return <span className="cue-thumb is-unreadable" aria-hidden="true" title={`No thumbnail: ${failure}`}>!</span>
  }
  return <span className="cue-thumb" aria-hidden="true" />
}

interface PlayScreenProps {
  readonly show: Show
  readonly showRef: RefObject<Show>
  readonly floor: FloorGeometry
  readonly status: SenderStatus
  /** Why the sender is down, straight from the child's stderr. */
  readonly senderError: string | null
  readonly snapshot: EngineSnapshot
  readonly stats: RenderStats
  readonly engine: PlayerEngine<VideoSource>
  readonly previewContainerRef: RefObject<HTMLDivElement | null>
  readonly applyShow: (next: Show) => void
  readonly refreshSnapshot: () => void
  readonly setSurface: (surface: 'mapping' | 'play') => void
  readonly zoom: number
  readonly onZoomIn: () => void
  readonly onZoomOut: () => void
  readonly onZoomFit: () => void
  readonly onZoomSet: (zoom: number) => void
}

type IconName = 'plus' | 'up' | 'down' | 'trash' | 'pencil' | 'previous' | 'next' | 'play' | 'pause'

const ADD_CUE_MENU_ID = 'add-cue-menu'

function Icon({ name, size = 16 }: { readonly name: IconName; readonly size?: number }): ReactNode {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  switch (name) {
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>
    case 'up':
      return <svg {...common}><path d="m6 15 6-6 6 6" /></svg>
    case 'down':
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>
    case 'trash':
      return <svg {...common}><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></svg>
    case 'pencil':
      return <svg {...common}><path d="m4 20 4.2-1 10.5-10.5-3.2-3.2L5 15.8 4 20ZM13.8 7l3.2 3.2" /></svg>
    case 'previous':
      return <svg {...common}><path d="M6 6v12M18 7l-8 5 8 5V7Z" /></svg>
    case 'next':
      return <svg {...common}><path d="M18 6v12M6 7l8 5-8 5V7Z" /></svg>
    case 'play':
      return <svg {...common}><path d="m8 5 11 7-11 7V5Z" /></svg>
    case 'pause':
      return <svg {...common}><path d="M9 5v14M15 5v14" /></svg>
  }
}

/**
 * Console model: a control the operator clicked does not stay armed.
 *
 * `mousedown`'s default action is what focuses a button, so refusing it leaves
 * focus where it was and still delivers the `click`. Two consequences, both
 * wanted. Enter no longer re-fires whatever was last touched — Space is
 * globally GO now, but Enter is not intercepted, so a lingering BLACKOUT would
 * still be one keystroke from toggling. And the accent `:focus-visible` ring
 * never appears on a row: Chromium withholds it on a mouse click but re-arms it
 * on the operator's next keypress, which is precisely the click-then-↓ sequence
 * the standby helper row advertises, and is how a second row came to look
 * selected. No focus, no ring.
 *
 * Keyboard focus is untouched — this fires only for a real pointer press, so
 * `:focus-visible` still does its accessibility job for anyone navigating by
 * key.
 */
const dropFocus = (event: React.MouseEvent): void => event.preventDefault()

function cueRowClass(cue: Cue, selectedCueId: string | null, snapshot: EngineSnapshot): string {
  const classes = ['cue-row']
  if (cue.id === snapshot.liveCueId) classes.push('is-live')
  if (cue.id === snapshot.standbyCueId) classes.push('is-standby')
  if (cue.id === snapshot.pendingCueId) classes.push('is-pending')
  if (cue.id === selectedCueId) classes.push('is-selected')
  return classes.join(' ')
}

/**
 * GO must never re-fire the cue that is already live: with no distinct
 * standby cue armed, GO would restart the live cue's decoder mid-playback for
 * no operator-visible reason. Exported so the mutation-check can grade this
 * condition without rendering the component.
 */
export function isGoDisabled(snapshot: Pick<EngineSnapshot, 'standbyCueId' | 'liveCueId'>): boolean {
  return snapshot.standbyCueId === null || snapshot.standbyCueId === snapshot.liveCueId
}

/**
 * Fraction of the live cue's clip already played, from the engine's actual
 * decode position — not the cue's elapsed-since-armed clock, which stays at
 * the cue's own duration bookkeeping and never reflects a cue with no
 * `durationMs` set (it holds until GO, so `elapsedMs`/`cueDurationMs` isn't
 * the clip's position). Exported for the mutation-check.
 */
export function timelineProgress(snapshot: Pick<EngineSnapshot, 'positionMs' | 'mediaDurationMs'>): number {
  return snapshot.mediaDurationMs === null || snapshot.mediaDurationMs <= 0
    ? 0
    : Math.min(1, Math.max(0, snapshot.positionMs / snapshot.mediaDurationMs))
}

/**
 * What clicking a cue row targets — both `selectedCueId` (the inspector,
 * rotation edit, rename, move, and delete all read it) and the id handed to
 * `engine.selectCue`. It is the clicked cue, in every mode. Kept as a named
 * function rather than inlined because the mutation-check grades it, and
 * because the thing it must keep being is a promise, not an implementation:
 * **standby ≡ preview ≡ what was clicked.**
 *
 * Until 2026-08-15 this re-targeted the *next* cue when the live row was
 * clicked in Preview, on the reasoning that re-previewing what is already on
 * the floor shows nothing new while auditioning the next cue does. MEASURED
 * the same day, with a real click on the live row in Preview: the live row
 * keeps its green glow, the row *below* it takes the blue preview selection,
 * and the inspector reads that next cue's name. Two rows carry an affordance
 * and the operator's rename, rotate, move and delete now aim one row below
 * where they clicked — the divergence the paragraph above forbids, written in
 * deliberately.
 *
 * The convenience it bought is available without the divergence: click the
 * next cue. The cost it charged was a silent aiming error on four destructive
 * controls, during a show.
 */
export function selectCueTarget(cueId: string): string {
  return cueId
}

export function PlayScreen({
  show,
  showRef,
  floor,
  status,
  senderError,
  snapshot,
  stats,
  engine,
  previewContainerRef,
  applyShow,
  refreshSnapshot,
  setSurface,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onZoomSet,
}: PlayScreenProps) {
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const [zoomEditing, setZoomEditing] = useState(false)
  const [zoomDraft, setZoomDraft] = useState('')
  const [renamingCueId, setRenamingCueId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [library, setLibrary] = useState<{ dir: string; files: string[] } | null>(null)
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, string>>(new Map())
  /** Cue id to the reason its thumbnail will never arrive. See `CueThumb`. */
  const [thumbFailures, setThumbFailures] = useState<ReadonlyMap<string, string>>(new Map())
  const thumbAttempted = useRef(new Set<string>())
  const shellRef = useRef<HTMLElement>(null)

  const selectCue = (cueId: string): void => {
    const target = selectCueTarget(cueId)
    setSelectedCueId(target)
    engine.selectCue(target)
    refreshSnapshot()
  }

  const refreshLibrary = async (): Promise<void> => {
    setLibrary(await window.pxdf.listMediaDir())
  }

  usePopoverEscape(ADD_CUE_MENU_ID)

  useEffect(() => {
    void refreshLibrary()
  }, [])

  useEffect(() => {
    const cueIds = new Set(show.cues.map((cue) => cue.id))
    thumbAttempted.current.forEach((cueId) => {
      if (!cueIds.has(cueId)) thumbAttempted.current.delete(cueId)
    })
    setThumbnails((prev) => {
      const next = new Map([...prev].filter(([cueId]) => cueIds.has(cueId)))
      return next.size === prev.size ? prev : next
    })
    setThumbFailures((prev) => {
      const next = new Map([...prev].filter(([cueId]) => cueIds.has(cueId)))
      return next.size === prev.size ? prev : next
    })

    for (const cue of show.cues) {
      if (thumbAttempted.current.has(cue.id)) continue
      thumbAttempted.current.add(cue.id)
      // Through the pool, not straight at the decoder. `captureThumbnail`'s
      // deadline starts when its task starts, so what is bounded here has to
      // be the call itself rather than anything inside it — a pool that queued
      // an already-running probe would bound nothing at all.
      void THUMBNAIL_POOL.run(() => captureThumbnail(cue.source.path)).then((canvas) => {
        const url = canvas.toDataURL()
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(cue.id, url)
          return next
        })
      }).catch((error: unknown) => {
        // Not `.catch(() => {})`. Every queued thumbnail now either produces
        // one or says why it did not, in both channels: the row's marker and
        // the log. The path is named because the cue's name is the operator's
        // word for the file and the path is the one that can be opened — the
        // same lesson the 116 path-less `ERROR player` lines taught.
        const reason = error instanceof Error ? error.message : String(error)
        setThumbFailures((prev) => {
          const next = new Map(prev)
          next.set(cue.id, reason)
          return next
        })
        window.pxdf.log('WARN', 'player', `no thumbnail for cue "${cue.name}": ${reason} — ${cue.source.path}`)
      })
    }
  }, [show.cues])

  /**
   * Build a cue per path, insert them, select the first, and probe each one's
   * media duration.
   *
   * Both ways of adding a cue route through here. They did not once: the
   * Library row built its own `Cue` literal and never probed, so a cue added
   * from the Library kept `mediaDurationMs: null` for the rest of the show —
   * its inspector Duration read `—` forever, and setting Loop on it gave
   * `cueHoldMs` a null `clipDurationMs` to multiply, which the engine reads as
   * "never advance". Two literals is how that came back; one is how it stays
   * fixed.
   */
  const addCuesFromPaths = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0) return
    const seed = await window.pxdf.cueSeed()

    let cues = [...showRef.current.cues]
    // The *first* of the added cues, not the last. Selecting a cue in live
    // mode arms it as Standby, so selecting the last one means that adding
    // five clips and pressing GO starts the show on clip five. The wire gate
    // caught this: it pressed GO expecting cue 1 and got cue 2.
    let firstAddedId: string | null = null
    const added: Cue[] = []
    for (const path of paths) {
      const override = seed[path]
      const cue: Cue = {
        id: nextCueId(cues),
        name: cueNameFromPath(path),
        source: { kind: 'video', path },
        loop: override?.loop ?? null,
        trimStartMs: override?.trimStartMs ?? 0,
        trimEndMs: override?.trimEndMs ?? null,
        mediaDurationMs: null,
        rotation: 0,
      }
      cues = insertCue(cues, cue)
      added.push(cue)
      firstAddedId ??= cue.id
    }
    applyShow({ ...showRef.current, cues })
    if (firstAddedId !== null) selectCue(firstAddedId)
    void refreshLibrary()
    for (const cue of added) void probeCueDuration(cue)
  }

  const addMedia = async (): Promise<void> => {
    setPickerError(null)
    try {
      await addCuesFromPaths(await window.pxdf.pickMedia())
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : 'Media picker failed')
    }
  }

  const moveSelected = (offset: -1 | 1): void => {
    if (selectedCueId === null) return
    const from = showRef.current.cues.findIndex((cue) => cue.id === selectedCueId)
    if (from < 0) return
    applyShow({ ...showRef.current, cues: moveCue(showRef.current.cues, selectedCueId, from + offset) })
  }

  const removeSelected = (): void => {
    if (selectedCueId === null) return
    const index = showRef.current.cues.findIndex((cue) => cue.id === selectedCueId)
    const cues = removeCue(showRef.current.cues, selectedCueId)
    applyShow({ ...showRef.current, cues })
    setSelectedCueId(cues[Math.min(index, cues.length - 1)]?.id ?? null)
    setRenamingCueId(null)
  }

  const beginRename = (cue: Cue): void => {
    setRenamingCueId(cue.id)
    setRenameDraft(cue.name)
  }

  const finishRename = (): void => {
    if (renamingCueId === null) return
    applyShow({ ...showRef.current, cues: renameCue(showRef.current.cues, renamingCueId, renameDraft) })
    setRenamingCueId(null)
  }

  const setMode = (mode: PlayerMode): void => {
    engine.setMode(mode)
    if (mode === 'preview' && selectedCueId !== null) engine.selectCue(selectedCueId)
    refreshSnapshot()
  }

  // Shared by the ↑/↓ standby-step buttons and the ArrowUp/ArrowDown keys the
  // helper row underneath them advertises. selectedCueId is resynced to the
  // engine's own post-step standbyCueId (queried directly, not derived here)
  // so the inspector/rotation/rename/move/delete keep tracking whatever is
  // actually armed, the same contract selectCue holds for a direct click.
  const stepStandby = (direction: 'previous' | 'next'): void => {
    if (direction === 'previous') engine.selectPrevious()
    else engine.selectNext()
    setSelectedCueId(engine.snapshot().standbyCueId)
    refreshSnapshot()
  }

  const fireGo = (): void => {
    if (isGoDisabled(snapshot)) return
    engine.go()
    refreshSnapshot()
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      const isTextInput = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      if (isTextInput) return
      switch (event.key) {
        case 'Tab':
          event.preventDefault()
          setMode(snapshot.mode === 'live' ? 'preview' : 'live')
          return
        case 'ArrowUp':
          event.preventDefault()
          stepStandby('previous')
          return
        case 'ArrowDown':
          event.preventDefault()
          stepStandby('next')
          return
        case ' ':
        case 'Spacebar':
          // Unconditional, like Tab/ArrowUp/ArrowDown. This used to bail when
          // a <button> had focus, so that Space kept doing its native job of
          // activating the focused control. MEASURED 2026-08-15: click
          // BLACKOUT, press Space, and Space toggles BLACKOUT back off while
          // GO never fires — the operator's Space goes to the last thing they
          // touched instead of to the show. That is the dangerous direction of
          // the tradeoff the old comment chose knowingly, and the floor test
          // picked the other one: on a console, Space is GO, always.
          //
          // `preventDefault` here is also what stops the focused button's own
          // activation, which Chromium fires on keyup for Space.
          event.preventDefault()
          fireGo()
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [snapshot])

  const selectedLiveCue = show.cues.find((cue) => cue.id === snapshot.liveCueId) ?? null
  const liveCueIndex = selectedLiveCue === null ? -1 : show.cues.findIndex((cue) => cue.id === selectedLiveCue.id)
  const progress = timelineProgress(snapshot)

  const probeCueDuration = async (cue: Cue): Promise<void> => {
    // The `VideoSource` is constructed inside the pooled task and nowhere
    // else: constructing it opens the decoder, so building it at the call site
    // and queueing the `await` would hold the pool's shape and none of its
    // effect.
    await DURATION_POOL.run(async () => {
      const probe = new VideoSource(cue.source.path)
      try {
        const mediaDurationMs = await probeDurationMs(probe)
        applyShow({
          ...showRef.current,
          cues: showRef.current.cues.map((each) => (each.id === cue.id ? { ...each, mediaDurationMs } : each)),
        })
      } catch (error: unknown) {
        // A failed probe still leaves `mediaDurationMs: null`, which the
        // inspector renders as an em dash — but an em dash is also what a
        // probe still in flight looks like, and the consequence is not
        // cosmetic: `cueHoldMs` on a null `clipDurationMs` is the engine's
        // "never advance", so Loop on that cue does nothing at all. That used
        // to be recorded nowhere. It is one line now.
        const reason = error instanceof Error ? error.message : String(error)
        window.pxdf.log('WARN', 'player', `no media length for cue "${cue.name}": ${reason} — ${cue.source.path}`)
      } finally {
        probe.dispose()
      }
    })
  }

  const selectedCue = show.cues.find((cue) => cue.id === selectedCueId) ?? null

  const selectedIndex = selectedCue === null ? -1 : show.cues.findIndex((cue) => cue.id === selectedCue.id)
  // Sender first. A cue that will not decode is a problem with one cue; a
  // sender that is down is the whole floor, and during a show the operator gets
  // one glance at this line.
  const visibleError = senderError ?? snapshot.lastError ?? pickerError

  const commitZoomDraft = (): void => {
    const parsed = parseZoomPercent(zoomDraft)
    if (parsed !== null) onZoomSet(parsed)
    setZoomEditing(false)
  }

  const startResize = (
    cssVar: '--w-sidebar' | '--w-inspector',
    direction: 1 | -1,
  ): ((event: React.PointerEvent<HTMLDivElement>) => void) => (event) => {
    const shell = shellRef.current
    if (shell === null) return
    const startX = event.clientX
    const startWidth = parseFloat(getComputedStyle(shell).getPropertyValue(cssVar)) || 0

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Losing pointer capture is not fatal: window listeners still resize.
    }

    const onMove = (moveEvent: PointerEvent): void => {
      const delta = (moveEvent.clientX - startX) * direction
      const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidth + delta))
      shell.style.setProperty(cssVar, `${next}px`)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <main ref={shellRef} className={`player-shell mode-${snapshot.mode} play-screen`}>
      <header className="title-bar">
        <span className="show-title">PXDF Player — {show.name}</span>
        <span className="geometry-readout">
          {floor.tileCols} × {floor.tileRows} · {floor.widthPx} × {floor.heightPx}
        </span>
        <button type="button" className="button ghost small" onClick={() => setSurface('mapping')}>Mapping…</button>
        <StatusPill status={status} />
      </header>

      <div className="player-body">
        <aside className="cue-stack" aria-label="Cue stack">
          <div className="panel-heading">
            <span className="section-label">Cue Stack</span>
            <button type="button" className="icon-button compact add-cue-trigger" title="Add cue" aria-label="Add cue" popoverTarget={ADD_CUE_MENU_ID}>
              <Icon name="plus" size={15} />
            </button>
            <div id={ADD_CUE_MENU_ID} popover="auto" className="add-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { document.getElementById(ADD_CUE_MENU_ID)?.hidePopover(); void addMedia() }}>Upload media…</button>
              <button type="button" role="menuitem" disabled title="Cue editing arrives with the Edit surface, not yet built">Create in editor</button>
            </div>
          </div>

          {/* A listbox, not a stack of buttons. Each row was a <button> until
              2026-08-15, which made it focusable, which made the shared
              `button:focus-visible` rule paint a full accent outline on it — a
              second thing that looks selected, in the same accent as
              `.cue-row.is-selected`'s left bar, on a different row. `role=option`
              on a div is not focusable, so that ring has nowhere to land, and
              ↑/↓/Space are window-level handlers already: none of the keyboard
              behaviour lived on the button.

              Focus moves to the *list*, not to a row: that is the second half
              of the same decision, and without it this is a malformed widget
              rather than a smaller one. A listbox has to have somewhere for
              focus to land, and it names its current option with
              `aria-activedescendant` instead of by focusing it — which is
              exactly the shape wanted here, since the whole point is that no
              row is ever focused. Assistive tech reads the active option and
              its `aria-selected` off the ids below; a sighted operator sees
              the same thing as the accent bar. `button:focus-visible` cannot
              match a div, so the ring still has nowhere to land. */}
          <div
            className="cue-list"
            role="listbox"
            aria-label="Cues"
            tabIndex={0}
            aria-activedescendant={selectedCueId === null ? undefined : `cue-row-${selectedCueId}`}
          >
            {show.cues.length === 0 && (
              <div className="empty-cues" role="presentation">Add a video to build this show.</div>
            )}
            {show.cues.map((cue, index) => (
              renamingCueId === cue.id ? (
                <form
                  key={cue.id}
                  // Not `role="option"`, even though it takes an option's slot
                  // and wears its class: an option may not contain a focusable
                  // descendant, and this one is a text field the operator is
                  // typing into. `presentation` hands the row's own semantics
                  // back to the input, which is the only thing to interact
                  // with while a rename is open. The row it replaces is gone
                  // from `aria-activedescendant` for exactly as long as the
                  // rename lasts, which is true rather than merely convenient.
                  role="presentation"
                  className={cueRowClass(cue, selectedCueId, snapshot)}
                  onSubmit={(event) => { event.preventDefault(); finishRename() }}
                >
                  <CueThumb url={thumbnails.get(cue.id)} failure={thumbFailures.get(cue.id)} />
                  <span className="cue-number">{(index + 1).toString().padStart(2, '0')}</span>
                  <span className="rename-form">
                    <input
                      autoFocus
                      value={renameDraft}
                      aria-label="Cue name"
                      onChange={(event) => setRenameDraft(event.currentTarget.value)}
                      onBlur={finishRename}
                    />
                  </span>
                  {cue.id === snapshot.liveCueId && (
                    <span className="playing-indicator" title="Playing">
                      <span /><span /><span />
                    </span>
                  )}
                  {cue.id === snapshot.standbyCueId && snapshot.standbyCueId !== snapshot.liveCueId
                    ? <span className="standby-marker">Standby</span>
                    : <span className="cue-duration">{formatTimecode(cueHoldMs(cue))}</span>}
                </form>
              ) : (
                <div
                  key={cue.id}
                  // Prefixed rather than bare `cue.id`, which is only unique
                  // within the show — an id has to be unique in the document.
                  id={`cue-row-${cue.id}`}
                  role="option"
                  aria-selected={cue.id === selectedCueId}
                  className={cueRowClass(cue, selectedCueId, snapshot)}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('text/plain', cue.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    const draggedId = event.dataTransfer.getData('text/plain')
                    if (draggedId.length > 0) {
                      applyShow({ ...showRef.current, cues: moveCue(showRef.current.cues, draggedId, index) })
                    }
                  }}
                  onClick={() => selectCue(cue.id)}
                  onDoubleClick={() => {
                    if (snapshot.mode === 'live') {
                      engine.goTo(cue.id)
                      refreshSnapshot()
                    }
                  }}
                >
                  <CueThumb url={thumbnails.get(cue.id)} failure={thumbFailures.get(cue.id)} />
                  <span className="cue-number">{(index + 1).toString().padStart(2, '0')}</span>
                  <span className="cue-name">{cue.name}</span>
                  {cue.id === snapshot.liveCueId && (
                    <span className="playing-indicator" title="Playing">
                      <span /><span /><span />
                    </span>
                  )}
                  {cue.id === snapshot.standbyCueId && snapshot.standbyCueId !== snapshot.liveCueId
                    ? <span className="standby-marker">Standby</span>
                    : <span className="cue-duration">{formatTimecode(cueHoldMs(cue))}</span>}
                </div>
              )
            ))}
          </div>

          {selectedCue !== null && (
            <div className="cue-actions" aria-label="Selected cue actions">
              <button type="button" className="icon-button compact" title="Move cue up" aria-label="Move cue up" onMouseDown={dropFocus} disabled={selectedIndex <= 0} onClick={() => moveSelected(-1)}><Icon name="up" /></button>
              <button type="button" className="icon-button compact" title="Move cue down" aria-label="Move cue down" onMouseDown={dropFocus} disabled={selectedIndex < 0 || selectedIndex >= show.cues.length - 1} onClick={() => moveSelected(1)}><Icon name="down" /></button>
              <button type="button" className="icon-button compact" title="Rename cue" aria-label="Rename cue" onMouseDown={dropFocus} onClick={() => beginRename(selectedCue)}><Icon name="pencil" /></button>
              <button type="button" className="icon-button compact danger" title="Remove cue" aria-label="Remove cue" onMouseDown={dropFocus} onClick={removeSelected}><Icon name="trash" /></button>
            </div>
          )}

          <div className="standby-controls">
            <div className="standby-row">
              <button type="button" className="standby-step" title="Standby previous cue" aria-label="Standby previous cue" onMouseDown={dropFocus} onClick={() => stepStandby('previous')}><Icon name="up" size={20} /></button>
              <button type="button" className="button primary go-button" disabled={isGoDisabled(snapshot)} onMouseDown={dropFocus} onClick={fireGo}>GO</button>
              <button type="button" className="standby-step" title="Standby next cue" aria-label="Standby next cue" onMouseDown={dropFocus} onClick={() => stepStandby('next')}><Icon name="down" size={20} /></button>
            </div>
            <div className="standby-helper"><span>↑</span><span>Space</span><span>↓</span></div>
          </div>

          <section className="library-section" aria-label="Media library">
            <button type="button" className="library-toggle" aria-expanded={libraryOpen} onClick={() => setLibraryOpen((v) => !v)}>Library</button>
            {libraryOpen && (library === null
              ? <div className="empty-cues">No folder picked yet</div>
              : library.files.length === 0
                ? <div className="empty-cues">This folder is empty</div>
                : library.files.map((path) => {
                  const basename = path.split('/').pop() ?? path
                  return (
                    <button
                      type="button"
                      className="library-row"
                      key={path}
                      onClick={() => { void addCuesFromPaths([path]) }}
                    >{basename}</button>
                  )
                }))}
          </section>
        </aside>

        <div className="resize-gutter" data-gutter="sidebar" role="separator" aria-orientation="vertical" aria-label="Resize cue stack" onPointerDown={startResize('--w-sidebar', 1)} />

        <section className="preview-column" aria-label="Floor preview">
          <div className="preview-heading">
            <span className="section-label">
              Floor A · {floor.tileCols * floor.tileRows} Tiles
            </span>
            <span className="key-hint">Tab</span>
            <div className="segmented" aria-label="Player mode">
              {(['live', 'preview'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={snapshot.mode === mode ? 'is-active' : ''}
                  aria-pressed={snapshot.mode === mode}
                  onMouseDown={dropFocus}
                  onClick={() => setMode(mode)}
                >
                  <span className="segment-dot" />{mode === 'live' ? 'Live' : 'Preview'}
                </button>
              ))}
            </div>
            <div className="segmented" aria-label="Zoom controls">
              <button type="button" className="icon-button compact" title="Zoom out" aria-label="Zoom out" onClick={onZoomOut}>−</button>
              {zoomEditing ? (
                <input autoFocus type="text" inputMode="numeric" maxLength={3} className="zoom-percent-input" aria-label="Zoom percent" value={zoomDraft} onChange={(event) => setZoomDraft(event.currentTarget.value.replace(/\D/g, ''))} onBlur={commitZoomDraft} onKeyDown={(event) => { if (event.key === 'Enter') { event.currentTarget.blur() } else if (event.key === 'Escape') { setZoomEditing(false) } }} />
              ) : (
                <span onDoubleClick={() => { setZoomDraft(zoomPercentText(zoom)); setZoomEditing(true) }}>{zoomPercentText(zoom)}%</span>
              )}
              <button type="button" className="icon-button compact" title="Zoom in" aria-label="Zoom in" onClick={onZoomIn}>+</button>
              <button type="button" className="button ghost small" title="Zoom to fit" aria-label="Zoom to fit" onClick={onZoomFit}>Fit</button>
            </div>
          </div>
          <div className="preview-well">
            <div
              ref={previewContainerRef}
              className="preview-canvas-host"
              style={{ aspectRatio: `${floor.widthPx} / ${floor.heightPx}` }}
            />
          </div>
          <div className="timeline-panel">
            <div className="timeline-heading">
              <span className="section-label">{selectedLiveCue === null ? 'No live cue' : `Cue ${String(liveCueIndex + 1).padStart(2, '0')}`} · clip position</span>
              <span className="timeline-spacer" />
              <span className="timeline-time">{formatTimecode(snapshot.positionMs)}<span> / {snapshot.mediaDurationMs === null ? '∞' : formatTimecode(snapshot.mediaDurationMs)}</span></span>
              <span className="timeline-loop-chip">LOOP ∞</span>
            </div>
            <div className="timeline-track" role="progressbar" aria-label="Clip position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              {Array.from({ length: TIMELINE_SEGMENTS }, (_, i) => {
                const segmentProgress = (i + 1) / TIMELINE_SEGMENTS
                const cursorProgress = (i + 0.5) / TIMELINE_SEGMENTS
                const isCursor = Math.abs(cursorProgress - progress) < 1 / TIMELINE_SEGMENTS
                const isPlayed = !isCursor && segmentProgress <= progress
                return <span key={i} className={`timeline-segment${isCursor ? ' is-cursor' : isPlayed ? ' is-played' : ''}`} />
              })}
            </div>
            <div className="timeline-footer">
              <span>Read-only while LIVE · scrub in Preview</span>
              <span className="render-readout"><strong>{snapshot.mode.toUpperCase()}</strong><span> · {stats.fps.toFixed(1)} fps · {stats.passMs.toFixed(2)} ms one-pass</span></span>
            </div>
          </div>
          {visibleError !== null && <div className="error-banner" role="status">{visibleError}</div>}
          {/* Reusing `.notice-banner` rather than adding a colour: its comment in
              index.css already draws the line this needs — something the operator
              is being told, not something that went wrong. A buffering clip in
              danger red is a false alarm, and it recovers on its own.

              Only when nothing has actually failed. There is one line here and
              one glance at it, and a stall reported underneath a dead cue is the
              less useful of two true things. */}
          {visibleError === null && snapshot.stallWarning !== null && (
            <div className="notice-banner" role="status">{snapshot.stallWarning}</div>
          )}
        </section>

        <div className="resize-gutter" data-gutter="inspector" role="separator" aria-orientation="vertical" aria-label="Resize inspector" onPointerDown={startResize('--w-inspector', -1)} />

        <aside className="inspector" aria-label="Cue inspector">
          <span className="section-label">Cue Control</span>
          <div className="cue-summary">
            <strong>{selectedCue?.name ?? 'No cue selected'}</strong>
            <span>{selectedCue === null ? '—' : formatTimecode(cueHoldMs(selectedCue))}</span>
          </div>

          <div className="duration-control">
            <span className="control-heading">Duration</span>
            <div className="cue-duration-readout">
              {selectedCue === null || clipDurationMs(selectedCue) === null ? '—' : formatTimecode(clipDurationMs(selectedCue))}
            </div>
          </div>

          <div className="rotation-control">
            <span className="control-heading">Rotate</span>
            <div className="segmented" aria-label="Cue rotation">
              {([0, 90, 180, 270] as const).map((rotation) => (
                <button
                  type="button"
                  key={rotation}
                  aria-label={`Rotate cue ${rotation} degrees`}
                  aria-pressed={selectedCue?.rotation === rotation}
                  className={selectedCue?.rotation === rotation ? 'is-active' : ''}
                  disabled={selectedCue === null}
                  onClick={() => {
                    if (selectedCue !== null) {
                      applyShow({ ...showRef.current, cues: setCueRotation(showRef.current.cues, selectedCue.id, rotation) })
                    }
                  }}
                >{rotation}°</button>
              ))}
            </div>
          </div>

          <label className="disabled-control" title="Speed arrives in PR 4">
            <span><span>Speed</span><output>100%</output></span>
            <input type="range" value="100" min="0" max="200" disabled readOnly />
            <small>Available in PR 4</small>
          </label>

          <div className="disabled-control" title="Reverse and Bounce are shelved; v1 is forward-only">
            <span>Direction</span>
            <div className="segmented disabled" aria-disabled="true">
              <button type="button" className="is-active" disabled>Fwd</button>
              <button type="button" disabled>Rev</button>
              <button type="button" disabled>Bounce</button>
            </div>
            <small>Forward-only in v1</small>
          </div>

          <label className="disabled-control" title="Brightness arrives in PR 4">
            <span><span>Brightness</span><output>100%</output></span>
            <input type="range" value="100" disabled readOnly />
            <small>Available in PR 4</small>
          </label>

          <div className="inspector-rule" />
          <div className="disabled-control" title="Per-cue fades arrive in PR 4">
            <span>Fade in</span>
            <div className="segmented disabled" aria-disabled="true">
              <button type="button" className="is-active" disabled>Global</button>
              <button type="button" disabled>Custom</button>
            </div>
            <small>Available in PR 4</small>
          </div>

          <span title="Cue editing arrives in PR 4"><button type="button" className="button secondary full" disabled>Edit Cue…</button></span>

        </aside>
      </div>

      <footer className="transport" aria-label="Transport controls">
        <label className="master-control">
          <span className="section-label">Master</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(snapshot.master * 100)}
            onChange={(event) => { engine.setMaster(event.currentTarget.valueAsNumber / 100); refreshSnapshot() }}
          />
          <output>{Math.round(snapshot.master * 100)}%</output>
        </label>
        <span className="transport-divider" />
        <div className="crossfade-control" title="Crossfade arrives with the Compositor"><span className="section-label">Crossfade</span><input type="range" min="0" max="60" value="15" disabled readOnly /><output>1.5 s</output></div>
        <span className="transport-spacer" />
        <span className="transport-divider" />
        <div className="transport-action"><button type="button" className="button primary transport-big-button" title={snapshot.transportPaused ? 'Resume' : 'Pause'} onMouseDown={dropFocus} onClick={() => { engine.setPaused(!snapshot.transportPaused); refreshSnapshot() }}><Icon name={snapshot.transportPaused ? 'play' : 'pause'} size={18} />{snapshot.transportPaused ? 'RESUME' : 'PAUSE'}</button><span className="key-hint">P</span></div>
        <div className="transport-action"><button type="button" className={`transport-big-button transport-blackout${snapshot.blackout ? ' is-active' : ''}`} aria-pressed={snapshot.blackout} onMouseDown={dropFocus} onClick={() => { engine.setBlackout(!snapshot.blackout); refreshSnapshot() }}>{snapshot.blackout ? 'BLACKOUT ACTIVE' : 'BLACKOUT'}</button><span className="key-hint">⌘B</span></div>
      </footer>
    </main>
  )
}
