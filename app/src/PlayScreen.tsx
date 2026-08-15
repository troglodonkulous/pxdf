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
 * `engine.selectCue`. These must always agree: if they diverged, those
 * controls would silently act on a different cue than the one being
 * previewed or armed.
 *
 * Outside Preview the target is always the clicked cue — Standby only makes
 * sense for what was actually clicked. In Preview, clicking the row that is
 * live re-targets the next cue instead, because re-previewing a cue that's
 * already on the floor shows nothing new; auditioning the next cue does.
 */
export function selectCueTarget(
  cueId: string,
  cues: readonly Cue[],
  mode: PlayerMode,
  liveCueId: string | null,
): string {
  if (mode !== 'preview' || cueId !== liveCueId) return cueId
  const index = cues.findIndex((cue) => cue.id === cueId)
  return cues[index + 1]?.id ?? cueId
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
  const thumbAttempted = useRef(new Set<string>())
  const shellRef = useRef<HTMLElement>(null)

  const selectCue = (cueId: string): void => {
    const target = selectCueTarget(cueId, show.cues, snapshot.mode, snapshot.liveCueId)
    setSelectedCueId(target)
    engine.selectCue(target)
    refreshSnapshot()
  }

  const refreshLibrary = async (): Promise<void> => {
    setLibrary(await window.ddf.listMediaDir())
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

    for (const cue of show.cues) {
      if (thumbAttempted.current.has(cue.id)) continue
      thumbAttempted.current.add(cue.id)
      void captureThumbnail(cue.source.path).then((canvas) => {
        const url = canvas.toDataURL()
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(cue.id, url)
          return next
        })
      }).catch(() => {})
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
    const seed = await window.ddf.cueSeed()

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
    for (const cue of added) void probeCueDuration(cue.id, cue.source.path)
  }

  const addMedia = async (): Promise<void> => {
    setPickerError(null)
    try {
      await addCuesFromPaths(await window.ddf.pickMedia())
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
          // Unlike Tab/ArrowUp/ArrowDown, this one has to yield to a focused
          // button: Space's native job is activating whatever button has
          // focus (BLACKOUT, PAUSE, a standby-step…), and Electron does give
          // clicked buttons focus. Hijacking it globally would silently fire
          // GO instead of the focused control's own click.
          if (target instanceof HTMLElement && target.tagName === 'BUTTON') return
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

  const probeCueDuration = async (cueId: string, path: string): Promise<void> => {
    const probe = new VideoSource(path)
    try {
      const mediaDurationMs = await probeDurationMs(probe)
      applyShow({
        ...showRef.current,
        cues: showRef.current.cues.map((cue) => (cue.id === cueId ? { ...cue, mediaDurationMs } : cue)),
      })
    } catch {
      // A failed probe remains represented by mediaDurationMs: null.
    } finally {
      probe.dispose()
    }
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
        <span className="show-title">DDF Player — {show.name}</span>
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

          <div className="cue-list">
            {show.cues.length === 0 && (
              <div className="empty-cues">Add a video to build this show.</div>
            )}
            {show.cues.map((cue, index) => (
              renamingCueId === cue.id ? (
                <form
                  key={cue.id}
                  className={cueRowClass(cue, selectedCueId, snapshot)}
                  onSubmit={(event) => { event.preventDefault(); finishRename() }}
                >
                  <span className="cue-thumb" aria-hidden="true">
                    {thumbnails.has(cue.id) ? <img src={thumbnails.get(cue.id)} alt="" width={40} height={24} /> : null}
                  </span>
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
                <button
                  type="button"
                  key={cue.id}
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
                  <span className="cue-thumb" aria-hidden="true">
                    {thumbnails.has(cue.id) ? <img src={thumbnails.get(cue.id)} alt="" width={40} height={24} /> : null}
                  </span>
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
                </button>
              )
            ))}
          </div>

          {selectedCue !== null && (
            <div className="cue-actions" aria-label="Selected cue actions">
              <button type="button" className="icon-button compact" title="Move cue up" aria-label="Move cue up" disabled={selectedIndex <= 0} onClick={() => moveSelected(-1)}><Icon name="up" /></button>
              <button type="button" className="icon-button compact" title="Move cue down" aria-label="Move cue down" disabled={selectedIndex < 0 || selectedIndex >= show.cues.length - 1} onClick={() => moveSelected(1)}><Icon name="down" /></button>
              <button type="button" className="icon-button compact" title="Rename cue" aria-label="Rename cue" onClick={() => beginRename(selectedCue)}><Icon name="pencil" /></button>
              <button type="button" className="icon-button compact danger" title="Remove cue" aria-label="Remove cue" onClick={removeSelected}><Icon name="trash" /></button>
            </div>
          )}

          <div className="standby-controls">
            <div className="standby-row">
              <button type="button" className="standby-step" title="Standby previous cue" aria-label="Standby previous cue" onClick={() => stepStandby('previous')}><Icon name="up" size={20} /></button>
              <button type="button" className="button primary go-button" disabled={isGoDisabled(snapshot)} onClick={fireGo}>GO</button>
              <button type="button" className="standby-step" title="Standby next cue" aria-label="Standby next cue" onClick={() => stepStandby('next')}><Icon name="down" size={20} /></button>
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
        <div className="transport-action"><button type="button" className="button primary transport-big-button" title={snapshot.transportPaused ? 'Resume' : 'Pause'} onClick={() => { engine.setPaused(!snapshot.transportPaused); refreshSnapshot() }}><Icon name={snapshot.transportPaused ? 'play' : 'pause'} size={18} />{snapshot.transportPaused ? 'RESUME' : 'PAUSE'}</button><span className="key-hint">P</span></div>
        <div className="transport-action"><button type="button" className={`transport-big-button transport-blackout${snapshot.blackout ? ' is-active' : ''}`} aria-pressed={snapshot.blackout} onClick={() => { engine.setBlackout(!snapshot.blackout); refreshSnapshot() }}>{snapshot.blackout ? 'BLACKOUT ACTIVE' : 'BLACKOUT'}</button><span className="key-hint">⌘B</span></div>
      </footer>
    </main>
  )
}
