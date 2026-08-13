import { useEffect, useState } from 'react'
import type { LinkStatus } from '../../electron/sidecar.js'
import type { ShowFloor } from '../player/show.js'
import { TILE_PX, type FloorGeometry, type Rotation } from '../render/geometry.js'
import {
  buildDiagram,
  deriveReadout,
  type DerivedReadout,
  type DiagramModel,
} from './diagramLayout.js'
import { parsePlanTable, type PlanTable } from './mapperPlan.js'

interface MappingScreenProps {
  readonly floor: FloorGeometry
  readonly rotation: Rotation
  readonly status: LinkStatus
  readonly changeFloor: (
    patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
  ) => Promise<void>
  readonly setRotation: (rotation: Rotation) => void
  readonly setSurface: (surface: 'mapping' | 'play') => void
}

interface NetworkInterface {
  readonly name: string
  readonly address: string
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

const TILE_COUNTS = Array.from({ length: 32 }, (_, index) => index + 1)
const ROTATIONS = [0, 90, 180, 270] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusLabel(status: LinkStatus): string {
  switch (status) {
    case 'linked': return 'Linked'
    case 'reconnecting': return 'Reconnecting'
    case 'dropped': return 'Dropped'
  }
}

export function MappingScreen({
  floor,
  rotation,
  status,
  changeFloor,
  setRotation,
  setSurface,
}: MappingScreenProps) {
  const [diagramState, setDiagramState] = useState<DiagramState>({ kind: 'loading' })
  const [highlightedCols, setHighlightedCols] = useState<readonly number[]>([])
  const [interfaces, setInterfaces] = useState<readonly NetworkInterface[]>([])
  const [selectedAddress, setSelectedAddress] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

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

  useEffect(() => {
    let active = true
    void window.ddf.listInterfaces()
      .then((nextInterfaces) => {
        if (!active) return
        setInterfaces(nextInterfaces)
        setSelectedAddress((current) => current || nextInterfaces[0]?.address || '')
      })
      .catch((error: unknown) => {
        if (active) setActionError(`Network interfaces failed: ${errorMessage(error)}`)
      })
    return () => { active = false }
  }, [])

  const selectFloor = async (
    patch: Partial<Pick<ShowFloor, 'type' | 'tileCols' | 'tileRows'>>,
  ): Promise<void> => {
    setActionError(null)
    try {
      await changeFloor(patch)
    } catch (error) {
      setActionError(`Floor change failed: ${errorMessage(error)}`)
    }
  }

  const selectInterface = async (address: string): Promise<void> => {
    setActionError(null)
    try {
      await window.ddf.setLocalIp(address)
      setSelectedAddress(address)
    } catch (error) {
      setActionError(`Network interface change failed: ${errorMessage(error)}`)
    }
  }

  const readyState = diagramState.kind === 'ready'
    && diagramState.plan.type === floor.type
    && diagramState.plan.tileCols === floor.tileCols
    && diagramState.plan.tileRows === floor.tileRows
    ? diagramState
    : null

  return (
    <main className="mapping-screen">
      <header className="title-bar">
        <span className="show-title">DDF Setup — Mapping</span>
        <span className={`status-pill status-${status}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel(status)}
        </span>
      </header>

      <div className="mapping-body">
        <section className="mapping-stage" aria-label="Floor wiring diagram">
          <div className="mapping-heading">
            <span className="section-label">Wiring · one connector per tile column</span>
            <div className="mapping-badges">
              <span>{floor.type}</span>
              {readyState !== null && <span>{readyState.plan.controllerCount} controllers</span>}
            </div>
          </div>

          {actionError !== null && (
            <div className="error-banner mapping-error-banner" role="alert">{actionError}</div>
          )}

          <div className="diagram-well">
            {readyState !== null ? (
              <svg
                className="mapping-diagram"
                viewBox={`0 0 ${readyState.diagram.canvasWidth} ${readyState.diagram.canvasHeight}`}
                role="img"
                aria-label="Controller wiring to floor tile columns"
              >
                {readyState.diagram.wires.map((wire) => (
                  <g
                    key={`wire-${wire.controller}-${wire.port}`}
                    className={`mapping-connector mapping-wire-color-${wire.colorIndex}`}
                    data-connector-col={wire.tileCol}
                    onMouseEnter={() => setHighlightedCols([wire.tileCol])}
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
                    <text x={controller.x + controller.width / 2} y={controller.y + 17} textAnchor="middle">
                      {controller.label}
                    </text>
                    {controller.ports.map((port) => (
                      <circle
                        key={port.port}
                        className={port.used
                          ? `mapping-port is-used mapping-wire-color-${port.port % 4}`
                          : 'mapping-port'}
                        cx={port.x}
                        cy={port.y}
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
                onChange={(event) => void selectFloor({ type: event.currentTarget.value })}
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
                {TILE_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            <label>
              <span>Height</span>
              <select
                aria-label="Floor height in tiles"
                value={floor.tileRows}
                onChange={(event) => void selectFloor({ tileRows: Number(event.currentTarget.value) })}
              >
                {TILE_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}
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
          <label className="mapping-network">
            <span className="section-label">Network</span>
            <select
              aria-label="Network interface"
              value={selectedAddress}
              onChange={(event) => void selectInterface(event.currentTarget.value)}
            >
              {interfaces.map((networkInterface) => (
                <option key={`${networkInterface.name}-${networkInterface.address}`} value={networkInterface.address}>
                  {networkInterface.name} — {networkInterface.address}
                </option>
              ))}
            </select>
          </label>

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
