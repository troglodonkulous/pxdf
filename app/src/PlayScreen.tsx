import { useState, type ReactNode, type RefObject } from 'react'
import type { SenderStatus } from '../electron/sidecar.js'
import { StatusPill } from './StatusPill.js'
import type { EngineSnapshot, PlayerEngine, PlayerMode } from './player/engine.js'
import { probeDurationMs } from './player/mediaDuration.js'
import {
  cueNameFromPath,
  DEFAULT_CUE_DURATION_MS,
  durationSecondsText,
  formatTimecode,
  insertCue,
  moveCue,
  parseDurationSeconds,
  removeCue,
  renameCue,
  setCueDuration,
  setCueRotation,
} from './player/playHelpers.js'
import { nextCueId, type Cue, type Show } from './player/show.js'
import { VideoSource } from './player/videoSource.js'
import type { FloorGeometry } from './render/geometry.js'

interface RenderStats {
  readonly fps: number
  readonly passMs: number
}

interface PlayScreenProps {
  readonly show: Show
  readonly showRef: RefObject<Show>
  readonly floor: FloorGeometry
  readonly status: SenderStatus
  readonly snapshot: EngineSnapshot
  readonly stats: RenderStats
  readonly engine: PlayerEngine<VideoSource>
  readonly previewContainerRef: RefObject<HTMLDivElement | null>
  readonly applyShow: (next: Show) => void
  readonly refreshSnapshot: () => void
  readonly setSurface: (surface: 'mapping' | 'play') => void
}

type IconName = 'plus' | 'up' | 'down' | 'trash' | 'pencil' | 'previous' | 'next' | 'play' | 'pause'

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

export function PlayScreen({
  show,
  showRef,
  floor,
  status,
  snapshot,
  stats,
  engine,
  previewContainerRef,
  applyShow,
  refreshSnapshot,
  setSurface,
}: PlayScreenProps) {
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const [renamingCueId, setRenamingCueId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pickerError, setPickerError] = useState<string | null>(null)
  /**
   * The duration field's text, tagged with the cue it was typed for.
   *
   * Tagged rather than synced by an effect: half-typed text is not a duration —
   * `2.` and `` are both unparseable on the way to `2.5` — so the field has to
   * hold text the cue does not, and an effect that copies the cue into the
   * field would fight the operator's keystrokes. Tagging means selecting
   * another cue simply stops matching and the field falls back to that cue's
   * real value, with no effect and no stale draft surviving the change.
   */
  const [durationDraft, setDurationDraft] = useState<{ cueId: string; text: string } | null>(null)
  const [probingDuration, setProbingDuration] = useState(false)

  const selectCue = (cueId: string): void => {
    setSelectedCueId(cueId)
    engine.selectCue(cueId)
    refreshSnapshot()
  }

  const addMedia = async (): Promise<void> => {
    setPickerError(null)
    try {
      const paths = await window.ddf.pickMedia()
      if (paths.length === 0) return

      let cues = [...showRef.current.cues]
      // The *first* of the added cues, not the last. Selecting a cue in live
      // mode arms it as Standby, so selecting the last one means that adding
      // five clips and pressing GO starts the show on clip five. The wire gate
      // caught this: it pressed GO expecting cue 1 and got cue 2.
      let firstAddedId: string | null = null
      for (const path of paths) {
        const cue: Cue = {
          id: nextCueId(cues),
          name: cueNameFromPath(path),
          source: { kind: 'video', path },
          durationMs: null,
          rotation: 0,
        }
        cues = insertCue(cues, cue)
        firstAddedId ??= cue.id
      }
      applyShow({ ...showRef.current, cues })
      if (firstAddedId !== null) selectCue(firstAddedId)
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : 'Media picker failed')
    }
  }

  const moveSelected = (offset: -1 | 1): void => {
    if (selectedCueId === null) return
    applyShow({ ...showRef.current, cues: moveCue(showRef.current.cues, selectedCueId, offset) })
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

  const selectedCue = show.cues.find((cue) => cue.id === selectedCueId) ?? null
  const holdsUntilGo = selectedCue === null || selectedCue.durationMs === null
  // The draft only speaks for the cue it was typed against; anything else falls
  // back to what that cue actually holds.
  const durationText = durationDraft !== null && durationDraft.cueId === selectedCueId
    ? durationDraft.text
    : durationSecondsText(selectedCue?.durationMs ?? null)

  const writeDuration = (cueId: string, durationMs: number | null): void => {
    // Through `applyShow`, which calls `engine.setShow`. That is what carries
    // the edit to a cue that is already playing; the engine reseats the live
    // slot rather than re-arming it, so the length changes without the clip
    // jumping back to its first frame.
    applyShow({ ...showRef.current, cues: setCueDuration(showRef.current.cues, cueId, durationMs) })
  }

  const editDuration = (text: string): void => {
    if (selectedCueId === null) return
    setDurationDraft({ cueId: selectedCueId, text })
    // Unparseable text leaves the cue alone rather than writing null, which is
    // "hold until GO" and not what a half-typed number means. The field marks
    // itself invalid and the cue keeps the last length that parsed.
    const durationMs = parseDurationSeconds(text)
    if (durationMs !== null) writeDuration(selectedCueId, durationMs)
  }

  const setDurationMode = (mode: 'hold' | 'set'): void => {
    if (selectedCue === null) return
    if (mode === 'hold') {
      writeDuration(selectedCue.id, null)
      setDurationDraft(null)
      return
    }
    // Switching to Set needs a number, and the cue does not have one yet. The
    // default is visible in the field and immediately editable, which is the
    // only reason an arbitrary constant is acceptable here.
    const durationMs = selectedCue.durationMs ?? DEFAULT_CUE_DURATION_MS
    writeDuration(selectedCue.id, durationMs)
    setDurationDraft({ cueId: selectedCue.id, text: durationSecondsText(durationMs) })
  }

  const fillDurationFromMedia = async (): Promise<void> => {
    const cue = selectedCue
    if (cue === null || probingDuration) return

    setProbingDuration(true)
    // A second decoder, not the live one. The live source only exists while the
    // cue is live, and the operator needs this for cues that are not playing.
    const probe = new VideoSource(cue.source.path)
    try {
      const durationMs = await probeDurationMs(probe)
      writeDuration(cue.id, durationMs)
      setDurationDraft({ cueId: cue.id, text: durationSecondsText(durationMs) })
      setPickerError(null)
    } catch (error) {
      // The one channel this has for bad news. Without it the button reads as
      // doing nothing, which is indistinguishable from a clip of length zero.
      setPickerError(error instanceof Error ? error.message : 'Could not read the media length')
    } finally {
      // In `finally`, so a rejected probe disposes too. This is the whole
      // lifetime of that decoder: it never outlives the click.
      probe.dispose()
      setProbingDuration(false)
    }
  }

  const selectedIndex = selectedCue === null ? -1 : show.cues.findIndex((cue) => cue.id === selectedCue.id)
  const progress = snapshot.cueDurationMs === null || snapshot.cueDurationMs <= 0
    ? 0
    : Math.min(1, snapshot.elapsedMs / snapshot.cueDurationMs)
  const visibleError = snapshot.lastError ?? pickerError

  return (
    <main className={`player-shell mode-${snapshot.mode} play-screen`}>
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
            <button type="button" className="icon-button compact" title="Add cue" aria-label="Add cue" onClick={() => void addMedia()}>
              <Icon name="plus" size={15} />
            </button>
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
                  {cue.id === snapshot.standbyCueId
                    ? <span className="standby-marker">Standby</span>
                    : <span className="cue-duration">{formatTimecode(cue.durationMs)}</span>}
                </form>
              ) : (
                <button
                  type="button"
                  key={cue.id}
                  className={cueRowClass(cue, selectedCueId, snapshot)}
                  onClick={() => selectCue(cue.id)}
                  onDoubleClick={() => {
                    if (snapshot.mode === 'live') {
                      engine.goTo(cue.id)
                      refreshSnapshot()
                    }
                  }}
                >
                  <span className="cue-number">{(index + 1).toString().padStart(2, '0')}</span>
                  <span className="cue-name">{cue.name}</span>
                  {cue.id === snapshot.standbyCueId
                    ? <span className="standby-marker">Standby</span>
                    : <span className="cue-duration">{formatTimecode(cue.durationMs)}</span>}
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

          <div className="go-wrap">
            <button
              type="button"
              className="button primary go-button"
              disabled={snapshot.standbyCueId === null}
              onClick={() => { engine.go(); refreshSnapshot() }}
            >GO</button>
          </div>
        </aside>

        <section className="preview-column" aria-label="Floor preview">
          <div className="preview-heading">
            <span className="section-label">
              Floor A · {floor.tileCols * floor.tileRows} Tiles
            </span>
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
          </div>
          <div className="preview-well">
            <div
              ref={previewContainerRef}
              className="preview-canvas-host"
              style={{ aspectRatio: `${floor.widthPx} / ${floor.heightPx}` }}
            />
          </div>
          <div className="render-readout">
            <strong>{snapshot.mode.toUpperCase()}</strong>
            <span> · {stats.fps.toFixed(1)} fps · {stats.passMs.toFixed(2)} ms one-pass</span>
          </div>
          {visibleError !== null && <div className="error-banner" role="status">{visibleError}</div>}
        </section>

        <aside className="inspector" aria-label="Cue inspector">
          <span className="section-label">Cue Control</span>
          <div className="cue-summary">
            <strong>{selectedCue?.name ?? 'No cue selected'}</strong>
            <span>{selectedCue === null ? '—' : formatTimecode(selectedCue.durationMs)}</span>
          </div>

          {/* The only enabled control in this panel, and the only cue property
              PR 2 owns. Everything below it belongs to the compositor. */}
          <div className="duration-control">
            <span className="control-heading">Duration</span>
            <div className="segmented" aria-label="Cue duration mode">
              <button
                type="button"
                className={holdsUntilGo ? 'is-active' : ''}
                aria-pressed={holdsUntilGo}
                disabled={selectedCue === null}
                onClick={() => setDurationMode('hold')}
              >Hold ∞</button>
              <button
                type="button"
                className={holdsUntilGo ? '' : 'is-active'}
                aria-pressed={!holdsUntilGo}
                disabled={selectedCue === null}
                onClick={() => setDurationMode('set')}
              >Set</button>
            </div>
            {selectedCue !== null && !holdsUntilGo && (
              <div className="duration-entry">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  aria-label="Cue duration in seconds"
                  className={parseDurationSeconds(durationText) === null ? 'is-invalid' : ''}
                  value={durationText}
                  onChange={(event) => editDuration(event.target.value)}
                />
                <span className="unit">s</span>
                {/* One shot, not a mode. It opens a second decoder for a cue
                    that may already be on the floor, reads the length off it
                    and disposes it -- see `fillDurationFromMedia`. */}
                <button
                  type="button"
                  className="button ghost small"
                  disabled={probingDuration}
                  onClick={() => void fillDurationFromMedia()}
                >{probingDuration ? 'Reading…' : 'Media'}</button>
              </div>
            )}
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

          <button
            type="button"
            className={`blackout-button${snapshot.blackout ? ' is-active' : ''}`}
            aria-pressed={snapshot.blackout}
            onClick={() => { engine.setBlackout(!snapshot.blackout); refreshSnapshot() }}
          >
            {snapshot.blackout ? 'BLACKOUT ACTIVE' : 'BLACKOUT'}
          </button>
        </aside>
      </div>

      <footer className="transport" aria-label="Transport controls">
        <div className="transport-buttons">
          <button type="button" className="icon-button" title="Previous cue" aria-label="Previous cue" onClick={() => { engine.selectPrevious(); refreshSnapshot() }}><Icon name="previous" size={18} /></button>
          <button
            type="button"
            className="icon-button primary transport-play"
            title={snapshot.transportPaused ? 'Resume' : 'Pause'}
            aria-label={snapshot.transportPaused ? 'Resume' : 'Pause'}
            onClick={() => { engine.setPaused(!snapshot.transportPaused); refreshSnapshot() }}
          ><Icon name={snapshot.transportPaused ? 'play' : 'pause'} size={20} /></button>
          <button type="button" className="icon-button" title="Next cue" aria-label="Next cue" onClick={() => { engine.selectNext(); refreshSnapshot() }}><Icon name="next" size={18} /></button>
        </div>

        <div className="timecode">{formatTimecode(snapshot.elapsedMs)} <span>/</span> {formatTimecode(snapshot.cueDurationMs)}</div>
        <div className="progress" role="progressbar" aria-label="Cue progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${progress * 100}%` }} />
          <i style={{ left: `calc(${progress * 100}% - 3px)` }} />
        </div>

        <div className="transport-disabled" title="Global fades arrive in PR 4">
          <span className="section-label">Fade</span>
          <button type="button" disabled>1.5 s</button>
        </div>

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
      </footer>
    </main>
  )
}
