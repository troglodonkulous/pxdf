import { useEffect, useState } from 'react'
import type { SenderStatus } from '../../electron/sidecar.js'
import type { ShowFloor } from '../player/show.js'
import {
  canvasSize,
  MAX_TILE_COLS,
  maxTileRows,
  TILE_PX,
  type FloorGeometry,
  type Rotation,
} from '../render/geometry.js'
import {
  buildDiagram,
  deriveReadout,
  type DerivedReadout,
  type DiagramModel,
} from './diagramLayout.js'
import { parsePlanTable, type PlanTable } from './mapperPlan.js'
import { StatusPill } from '../StatusPill.js'

export interface NetworkInterface {
  readonly name: string
  readonly address: string
}

interface MappingScreenProps {
  readonly floor: FloorGeometry
  readonly rotation: Rotation
  readonly status: SenderStatus
  /** Pushed from the main process's interface poll, not fetched on mount. */
  readonly interfaces: readonly NetworkInterface[]
  /** The address `mapper stream` is actually bound to. Empty means unbound. */
  readonly localIp: string
  /** Why the sender is down, straight from the child's stderr. */
  readonly senderError: string | null
  readonly selectInterface: (address: string) => Promise<void>
  readonly changeFloor: (
    patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
  ) => Promise<void>
  readonly setRotation: (rotation: Rotation) => void
  readonly setSurface: (surface: 'mapping' | 'play') => void
}

type DiagramState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly plan: PlanTable
      readonly diagram: DiagramModel
      readonly readout: DerivedReadout
    }

const COLUMN_COUNTS = Array.from({ length: MAX_TILE_COLS }, (_, index) => index + 1)
const ROTATIONS = [0, 90, 180, 270] as const

/**
 * The row counts this type can actually take.
 *
 * Per type, because `mapper` allows 22 rows of `8x8_4P` and only 11 of
 * `8x8_8P`. Offering a flat 1..32 for every type let the operator pick a floor
 * `mapper` refuses: `floorGeometry` waved it through, `doSetFloor` stopped the
 * running sidecar, and the replacement `mapper stream` exited on startup —
 * leaving the floor with no sender at all. Not offering the illegal value is
 * the first of the three guards; `floorGeometry` refusing it is the second, and
 * `doSetFloor` validating before it stops anything is the third.
 */
function rowCounts(type: string): readonly number[] {
  return Array.from({ length: maxTileRows(type) }, (_, index) => index + 1)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Shared by the trigger's `popoverTarget` and the panel's `id`. */
const NETWORK_HELP_ID = 'network-help'

/**
 * What to do when the cable is in and the floor is still dark.
 *
 * From a field session on 2026-08-13 that cost an hour and very nearly cost a
 * job: the floor NIC took a DHCP lease, won the default route, and killed
 * Wi-Fi along with it. Both remedies are here because the operator may be
 * somewhere they cannot use a terminal, and the System Settings route survives
 * a reboot where the `ipconfig` one does not.
 *
 * Deliberately not here: everything about `DDF_ADDRESS` and running from a dev
 * server. Operators run a packaged build, where that default does not apply,
 * and a panel that is mostly irrelevant is a panel nobody finishes reading.
 *
 * `popover="auto"` rather than a hand-rolled panel, and the difference is not
 * cosmetic. The first version was an absolutely-positioned div beside the
 * button, which put it inside `.mapping-inspector` — a 214 px rail with
 * `overflow: auto`, near the bottom of the window. It was clipped on two edges
 * at once and unreadable, which no test in this repo could have caught and one
 * screenshot did. The platform's popover renders in the **top layer**, so no
 * ancestor's `overflow` or `z-index` can reach it, and click-outside dismissal
 * comes with it. That deleted a click-catcher overlay and a piece of state.
 *
 * The Escape handler below is not that leftover. MEASURED in this Electron
 * build: click-outside light-dismiss works, and **Escape does not**, with focus
 * inside the panel or on the trigger. Escape is the expected way out of a
 * dialog that covers the window, so it is wired explicitly rather than
 * described in a comment as something the platform provides.
 */
function NetworkHelp() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const panel = document.getElementById(NETWORK_HELP_ID)
      // `:popover-open` rather than a piece of React state: the popover's
      // openness lives in the DOM, and mirroring it here would be a second
      // copy that can disagree with the first.
      if (panel instanceof HTMLElement && panel.matches(':popover-open')) panel.hidePopover()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div id={NETWORK_HELP_ID} popover="auto" className="popover">
      <p className="popover-title">Ethernet is connected but the floor gets nothing</p>
      <p>
        The floor NIC may be taking a DHCP lease and stealing the default route.
        That also drops Wi-Fi. Give it a static address with no gateway so it
        cannot win the route.
      </p>
      <p className="popover-step">Terminal</p>
      <code>sudo ipconfig set en18 MANUAL 10.200.50.78 255.0.0.0</code>
      <p className="popover-note">
        Revert any time with <code>sudo ipconfig set en18 DHCP</code>. Use the
        interface name shown in the dropdown, which is not necessarily{' '}
        <code>en18</code>.
      </p>
      <p className="popover-step">System Settings</p>
      <p>
        Network → ⋯ → Set Service Order, then drag Wi-Fi above Ethernet. Slower
        to do, but it survives a reboot.
      </p>
    </div>
  )
}

export function MappingScreen({
  floor,
  rotation,
  status,
  interfaces,
  localIp,
  senderError,
  selectInterface,
  changeFloor,
  setRotation,
  setSurface,
}: MappingScreenProps) {
  const [diagramState, setDiagramState] = useState<DiagramState>({ kind: 'loading' })
  const [highlightedCols, setHighlightedCols] = useState<readonly number[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setDiagramState({ kind: 'loading' })
    setHighlightedCols([])

    void window.ddf.mapperPlan(floor.type, floor.tileCols, floor.tileRows)
      .then((stdout) => {
        const plan = parsePlanTable(stdout)
        const diagram = buildDiagram(floor.type, floor.tileCols, floor.tileRows, plan)
        const readout = deriveReadout(floor, plan)
        if (active) setDiagramState({ kind: 'ready', plan, diagram, readout })
      })
      .catch((error: unknown) => {
        if (active) setDiagramState({ kind: 'failed', message: errorMessage(error) })
      })

    return () => { active = false }
  }, [floor.type, floor.tileCols, floor.tileRows])

  const selectFloor = async (
    patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
    notice: string | null = null,
  ): Promise<void> => {
    setActionError(null)
    setNotice(notice)
    try {
      await changeFloor(patch)
    } catch (error) {
      setActionError(`Floor change failed: ${errorMessage(error)}`)
      setNotice(null)
    }
  }

  /**
   * Changing type can invalidate a height nobody touched — 12 rows is legal on
   * `8x8_4P` and not on `8x8_8P`. Clamp rather than refuse, because refusing
   * makes the Type dropdown appear broken, but say so: quietly shrinking an
   * operator's floor by a third is the kind of silent success this project
   * keeps a postmortems file about.
   */
  const selectType = (type: string): void => {
    const limit = maxTileRows(type)
    if (floor.tileRows <= limit) {
      void selectFloor({ type })
      return
    }
    void selectFloor(
      { type, tileRows: limit },
      `Height reduced to ${limit}: ${type} allows at most ${limit} tile rows.`,
    )
  }

  const chooseInterface = async (address: string): Promise<void> => {
    setActionError(null)
    try {
      await selectInterface(address)
    } catch (error) {
      setActionError(`Network interface change failed: ${errorMessage(error)}`)
    }
  }

  /**
   * The bound address may not be in the list — the cable is out, or a
   * `DDF_LOCAL_IP` from the environment names an interface this machine does
   * not have. Showing it anyway, marked, beats the two alternatives: silently
   * re-pointing the dropdown at `interfaces[0]` (which is the bug this PR is
   * about) or dropping the operator's choice on the floor with no explanation.
   */
  const boundIsMissing = localIp !== '' && !interfaces.some((i) => i.address === localIp)

  const visibleError = senderError ?? actionError

  const readyState = diagramState.kind === 'ready'
    && diagramState.plan.type === floor.type
    && diagramState.plan.tileCols === floor.tileCols
    && diagramState.plan.tileRows === floor.tileRows
    ? diagramState
    : null

  // Rotation is applied here, at render time, and never reaches `buildDiagram`.
  // It is a *presentation* transform — the operator authoring a portrait floor
  // on a landscape canvas — not `mapper/orientation.py`, which is cabling
  // compensation and is settled at `identity` permanently. Keeping it out of the
  // model is what stops the two ever merging: `buildDiagram` is graded against
  // `mapper plan`, and a rotation argument would put a presentation choice
  // inside the thing that gate measures.
  const turned = rotation === 90 || rotation === 270
  const canvasW = readyState?.diagram.canvasWidth ?? 0
  const canvasH = readyState?.diagram.canvasHeight ?? 0
  const viewBox = turned ? `0 0 ${canvasH} ${canvasW}` : `0 0 ${canvasW} ${canvasH}`
  const rotateDiagram = rotation === 90 ? `translate(${canvasH} 0) rotate(90)`
    : rotation === 180 ? `translate(${canvasW} ${canvasH}) rotate(180)`
    : rotation === 270 ? `translate(0 ${canvasW}) rotate(270)`
    : undefined
  /**
   * Keeps a label readable inside a rotated diagram.
   *
   * Only at 180°, and the asymmetry is the point. A controller box is 80 x 50,
   * so its label fits along the long axis. At 90° and 270° that axis is vertical
   * and the label turns with it, which is where it fits; forcing it upright
   * there made it overlap the jacks and spill out of a 50px-wide box. At 180°
   * the box is still landscape, so upright fits — and upside-down text is the
   * one case that is simply unreadable rather than merely turned.
   */
  const readableAt = (x: number, y: number): string | undefined =>
    rotation === 180 ? `rotate(180 ${x} ${y})` : undefined
  const authorCanvas = canvasSize(floor, rotation)

  return (
    <main className="mapping-screen">
      <header className="title-bar">
        <span className="show-title">DDF Setup — Mapping</span>
        <StatusPill status={status} />
      </header>

      <div className="mapping-body">
        <section className="mapping-stage" aria-label="Floor wiring diagram">
          <div className="mapping-heading">
            <span className="section-label">Wiring · one connector = 2 ports = 2 tile columns</span>
            <div className="mapping-badges">
              <span>{floor.type}</span>
              {readyState !== null && <span>{readyState.plan.controllerCount} controllers</span>}
            </div>
          </div>

          {/*
            The sender's own complaint outranks anything this screen has to say
            about a dropdown: a floor that is dark is a bigger fact than a floor
            change that did not take, and one of the two is on stage.
          */}
          {visibleError !== null && (
            <div className="error-banner mapping-error-banner" role="alert">{visibleError}</div>
          )}
          {visibleError === null && notice !== null && (
            <div className="notice-banner mapping-error-banner" role="status">{notice}</div>
          )}

          <div className="diagram-well">
            {readyState !== null ? (
              <svg
                className="mapping-diagram"
                viewBox={viewBox}
                role="img"
                aria-label="Controller wiring to floor tile columns"
              >
                <g transform={rotateDiagram}>
                {readyState.diagram.wires.map((wire) => (
                  <g
                    key={`wire-${wire.controller}-${wire.jack}`}
                    className={`mapping-connector mapping-wire-color-${wire.colorIndex}`}
                    // Space-separated, because one cable feeds up to two
                    // columns. A single `data-connector-col` could only ever
                    // name one of the pair.
                    data-connector-cols={wire.tileCols.join(' ')}
                    onMouseEnter={() => setHighlightedCols(wire.tileCols)}
                    onMouseLeave={() => setHighlightedCols([])}
                  >
                    <path
                      className="mapping-wire"
                      d={`M ${wire.from.x} ${wire.from.y} V ${wire.from.y + wire.dropHeight} H ${wire.to.x} V ${wire.to.y}`}
                    />
                    <circle className="mapping-connector-end" cx={wire.to.x} cy={wire.to.y} r={5} />
                  </g>
                ))}

                {readyState.diagram.controllers.map((controller) => (
                  <g key={controller.index} className="mapping-controller">
                    <rect
                      x={controller.x}
                      y={controller.y}
                      width={controller.width}
                      height={controller.height}
                      rx={6}
                    />
                    <text
                      x={controller.x + controller.width / 2}
                      y={controller.y + 17}
                      textAnchor="middle"
                      transform={readableAt(controller.x + controller.width / 2, controller.y + 17)}
                    >
                      {controller.label}
                    </text>
                    {controller.jacks.map((jack) => (
                      <circle
                        key={jack.jack}
                        className={jack.used
                          ? `mapping-port is-used mapping-wire-color-${jack.jack}`
                          : 'mapping-port'}
                        cx={jack.x}
                        cy={jack.y}
                        r={5}
                      />
                    ))}
                  </g>
                ))}

                {readyState.diagram.edges.map((edge) => (
                  <rect
                    key={edge.tileCols.join('-')}
                    className="mapping-edge"
                    x={edge.x}
                    y={edge.y}
                    width={edge.width}
                    height={edge.height}
                    rx={3}
                  />
                ))}

                {readyState.diagram.tiles.map((tile) => (
                  <rect
                    key={`${tile.row}-${tile.col}`}
                    className={`mapping-tile${highlightedCols.includes(tile.col) ? ' is-highlighted' : ''}`}
                    data-tile-col={tile.col}
                    x={tile.x + 2}
                    y={tile.y + 2}
                    width={tile.size - 4}
                    height={tile.size - 4}
                    rx={3}
                  />
                ))}
                </g>
              </svg>
            ) : (
              <div className="diagram-placeholder" role="status">
                {diagramState.kind === 'failed'
                  ? `Wiring diagram unavailable: ${diagramState.message}`
                  : 'Loading mapper plan…'}
              </div>
            )}
          </div>

          {readyState !== null && (
            <div className="mapping-summary">
              {readyState.readout.tileCount} tiles · {readyState.readout.widthPx} × {readyState.readout.heightPx} px ·{' '}
              <strong>
                {readyState.readout.widthFt}′ {readyState.readout.widthIn.toFixed(1)}″ ×{' '}
                {readyState.readout.depthFt}′ {readyState.readout.depthIn.toFixed(1)}″
              </strong>{' '}
              · {readyState.readout.widthM.toFixed(2)} × {readyState.readout.depthM.toFixed(2)} m
            </div>
          )}
        </section>

        <aside className="mapping-inspector" aria-label="Mapping controls">
          <span className="section-label">Floor</span>
          <div className="mapping-fields">
            <label>
              <span>Type</span>
              <select
                aria-label="Floor type"
                value={floor.type}
                onChange={(event) => selectType(event.currentTarget.value)}
              >
                {Object.keys(TILE_PX).map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label>
              <span>Width</span>
              <select
                aria-label="Floor width in tiles"
                value={floor.tileCols}
                onChange={(event) => void selectFloor({ tileCols: Number(event.currentTarget.value) })}
              >
                {COLUMN_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            <label>
              <span>Height</span>
              <select
                aria-label="Floor height in tiles"
                value={floor.tileRows}
                onChange={(event) => void selectFloor({ tileRows: Number(event.currentTarget.value) })}
              >
                {rowCounts(floor.type).map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
          </div>

          {readyState !== null && (
            <div className="mapping-readout">
              <strong>
                {readyState.readout.widthFt}′ {readyState.readout.widthIn.toFixed(1)}″ ×{' '}
                {readyState.readout.depthFt}′ {readyState.readout.depthIn.toFixed(1)}″
              </strong>
              <span>{readyState.readout.widthM.toFixed(2)} × {readyState.readout.depthM.toFixed(2)} m · {readyState.readout.tileCount} tiles</span>
              <span>{readyState.readout.widthPx} × {readyState.readout.heightPx} px</span>
              {/*
                The floor's own size never changes — it is bolted to the ground.
                What Rotation changes is the canvas the operator authors on, so
                that is what gets a second line, and only when there is a
                difference to state. Reuses `canvasSize`; a second swap written
                out here would be a second implementation of the render's.
              */}
              {rotation !== 0 && (
                <span>{authorCanvas.width} × {authorCanvas.height} px canvas at {rotation}°</span>
              )}
              <span>{readyState.readout.controllerCount} controllers</span>
              <span>{readyState.readout.packetsPerFrame} packets · {readyState.readout.bytesPerFrame.toLocaleString()} B/frame</span>
            </div>
          )}
          <small className="mapping-caption">Tile = 500 mm. Imperial is derived, never input.</small>

          <div className="mapping-rule" />
          <span className="section-label">Rotation</span>
          <div className="rotation-group" aria-label="Floor rotation">
            {ROTATIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={rotation === option ? 'is-active' : ''}
                aria-label={`Rotation ${option} degrees`}
                aria-pressed={rotation === option}
                onClick={() => setRotation(option)}
              >{option}°</button>
            ))}
          </div>

          <div className="mapping-rule" />
          <div className="mapping-network">
            <div className="label-with-help">
              <span className="section-label">Network</span>
              <button
                type="button"
                className="help-button"
                aria-label="Why is the floor not receiving?"
                popoverTarget={NETWORK_HELP_ID}
              >i</button>
              <NetworkHelp />
            </div>
            <select
              aria-label="Network interface"
              value={localIp}
              onChange={(event) => void chooseInterface(event.currentTarget.value)}
            >
              {/*
                Nothing bound is a real state, and it needs a real option.
                Without one no `<option>` matches `value=""`, so the select
                displays the first interface while `mapper` runs with no
                `--local-ip` at all — the display disagreeing with the binding,
                which is the bug this whole panel was rewritten to remove,
                wearing a different hat. It says what is actually happening:
                the socket is unbound and datagrams leave by whichever route
                the OS prefers, which on a laptop with Wi-Fi is rarely the floor.
              */}
              {localIp === '' && <option value="">Default route — not pinned to a NIC</option>}
              {boundIsMissing && (
                <option value={localIp}>{localIp} — not connected</option>
              )}
              {interfaces.map((networkInterface) => (
                <option key={`${networkInterface.name}-${networkInterface.address}`} value={networkInterface.address}>
                  {networkInterface.name} — {networkInterface.address}
                </option>
              ))}
            </select>
          </div>

          <div className="mapping-rule" />
          <span className="section-label">Show File</span>
          <div className="show-file-controls" title="Show files arrive in PR 5">
            <button type="button" className="button small" disabled>Open…</button>
            <button type="button" className="button small" disabled>Save As…</button>
          </div>
          <small className="mapping-caption">Available in PR 5</small>

          <button type="button" className="button primary full open-player" onClick={() => setSurface('play')}>
            Open Player
          </button>
        </aside>
      </div>
    </main>
  )
}
