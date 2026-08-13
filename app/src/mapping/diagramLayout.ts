import { floorGeometry, type FloorGeometry } from '../render/geometry';
import type { PlanTable } from './mapperPlan';

export interface DiagramWire {
  readonly controller: number;
  readonly port: number;
  readonly tileCol: number;
  readonly colorIndex: number;
  readonly dropHeight: number;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

export interface DiagramTile {
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly originXPx: number;
  readonly originYPx: number;
}

export interface DiagramController {
  readonly index: number;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly ports: readonly {
    readonly port: number;
    readonly used: boolean;
    readonly x: number;
    readonly y: number;
  }[];
}

export interface DiagramEdge {
  readonly tileCols: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DiagramModel {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly controllers: readonly DiagramController[];
  readonly edges: readonly DiagramEdge[];
  readonly tiles: readonly DiagramTile[];
  readonly wires: readonly DiagramWire[];
}

export interface DerivedReadout {
  readonly tileCount: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly widthM: number;
  readonly depthM: number;
  readonly widthFt: number;
  readonly widthIn: number;
  readonly depthFt: number;
  readonly depthIn: number;
  readonly controllerCount: number;
  readonly packetsPerFrame: number;
  readonly bytesPerFrame: number;
}

const TILE_SIZE = 45;
const CONTROLLER_BAND_SIZE = 170;
const CONTROLLER_OFFSET_IN_BAND = 90;
const CONTROLLER_WIDTH = 80;
const CONTROLLER_HEIGHT = 50;
const EDGE_HEIGHT = 12;
const EDGE_DROP = 150;
const CONTENT_ABOVE_FLOOR = 162;
const CANVAS_PADDING = 50;

export function portsPerController(type: string): number {
  if (type.endsWith('_4P')) return 4;
  if (type.endsWith('_8P')) return 8;
  throw new Error(`unknown controller port count for type: ${type}`);
}

/**
 * One floor edge per tile column, at every type.
 *
 * `MAPPING-DIAGRAM.md` describes the vendor drawing wide `_8P` edges that span
 * two columns each, and says the `_8P` path is "not something PR 3 needs to get
 * right". That is a statement about the vendor's *physical connector*, and it is
 * not the mapping this diagram has to show: `mapper/frame.py:34` assigns ports
 * as `divmod(tile_col, ports_per_controller)`, which is one port per tile column
 * whatever the type. `python -m mapper plan --type 6x6_8P --cols 10 --rows 5`
 * bears that out — controller 0 uses ports 0-7 and controller 1 uses 0-1, ten
 * ports for ten columns.
 *
 * Pairing columns therefore drew five wires for ten columns and left half the
 * floor with no visible feed. `mapper` owns the topology, so the diagram follows
 * `mapper` and the per-type branch is gone. `tileCols` stays an array because an
 * edge is still allowed to represent more than one column if a later mockup
 * merges them visually — what it may not do is drop the ones it did not draw.
 */
function edgeColumns(tileCols: number): readonly (readonly number[])[] {
  return Array.from({ length: tileCols }, (_, col) => [col]);
}

/** Build renderer-independent diagram coordinates from mapper-owned topology. */
export function buildDiagram(
  type: string,
  tileCols: number,
  tileRows: number,
  plan: PlanTable,
): DiagramModel {
  const floor = floorGeometry(type, tileCols, tileRows);
  if (plan.type !== type || plan.tileCols !== tileCols || plan.tileRows !== tileRows) {
    throw new Error('mapper plan does not match requested floor');
  }
  if (!Number.isInteger(plan.controllerCount) || plan.controllerCount < 1) {
    throw new Error(`illegal controller count: ${plan.controllerCount}`);
  }

  const portCount = portsPerController(type);
  const controllerBand = CONTROLLER_BAND_SIZE * plan.controllerCount;
  const floorBand = TILE_SIZE * tileCols;
  const canvasWidth = Math.max(controllerBand, floorBand) + CANVAS_PADDING;
  const contentHeight = CONTENT_ABOVE_FLOOR + TILE_SIZE * tileRows;
  const canvasHeight = contentHeight + CANVAS_PADDING;
  const controllerGutter = (canvasWidth - controllerBand) / (plan.controllerCount + 1);
  const controllerY = (canvasHeight - contentHeight) / 2;
  const edgeX = (canvasWidth - floorBand) / 2;
  const edgeY = controllerY + EDGE_DROP;
  const floorY = edgeY + EDGE_HEIGHT;

  const controllers = Array.from({ length: plan.controllerCount }, (_, index): DiagramController => {
    const x = controllerGutter
      + CONTROLLER_OFFSET_IN_BAND
      + index * (CONTROLLER_BAND_SIZE + controllerGutter);
    const usedPorts = plan.portsByController.get(index) ?? [];
    const ports = Array.from({ length: portCount }, (_, port) => {
      if (usedPorts.some((usedPort) => usedPort >= portCount)) {
        throw new Error(`mapper plan names a port outside ${type}`);
      }
      return {
        port,
        used: usedPorts.includes(port),
        // Vendor coordinates name a socket's corner; wires need its centre.
        x: x + 17 + port * 15,
        y: controllerY + 35,
      };
    });
    return {
      index,
      label: `Controller ${index + 1}`,
      x,
      y: controllerY,
      width: CONTROLLER_WIDTH,
      height: CONTROLLER_HEIGHT,
      ports,
    };
  });

  const edgeColumnGroups = edgeColumns(tileCols);
  const edges = edgeColumnGroups.map((tileColumnGroup): DiagramEdge => ({
    tileCols: tileColumnGroup,
    x: edgeX + tileColumnGroup[0] * TILE_SIZE,
    y: edgeY,
    width: tileColumnGroup.length * TILE_SIZE,
    height: EDGE_HEIGHT,
  }));

  const tiles = Array.from({ length: tileRows }, (_, row) =>
    Array.from({ length: tileCols }, (_, col): DiagramTile => ({
      row,
      col,
      x: edgeX + col * TILE_SIZE,
      y: floorY + row * TILE_SIZE,
      size: TILE_SIZE,
      originXPx: col * floor.tilePx,
      originYPx: row * floor.tilePx,
    })),
  ).flat();

  const wires = edges.map((edge): DiagramWire => {
    const tileCol = edge.tileCols[0];
    const controller = Math.floor(tileCol / portCount);
    const port = tileCol % portCount;
    if (!plan.portsByController.get(controller)?.includes(port)) {
      throw new Error(`mapper plan has no route for tile column ${tileCol}`);
    }
    const socket = controllers[controller]?.ports[port];
    if (socket === undefined) throw new Error(`mapper plan route for tile column ${tileCol} is out of range`);
    return {
      controller,
      port,
      tileCol,
      colorIndex: port % 4,
      dropHeight: 70 + 10 * (port % 4),
      from: { x: socket.x, y: socket.y },
      to: { x: edge.x + edge.width / 2, y: edge.y },
    };
  });

  return { canvasWidth, canvasHeight, controllers, edges, tiles, wires };
}

function imperial(metres: number): { readonly feet: number; readonly inches: number } {
  const totalFeet = metres / 0.3048;
  const feet = Math.floor(totalFeet);
  return { feet, inches: (totalFeet - feet) * 12 };
}

export function deriveReadout(floor: FloorGeometry, plan: PlanTable): DerivedReadout {
  const widthM = floor.tileCols * 0.5;
  const depthM = floor.tileRows * 0.5;
  const width = imperial(widthM);
  const depth = imperial(depthM);
  return {
    tileCount: floor.tileCols * floor.tileRows,
    widthPx: floor.widthPx,
    heightPx: floor.heightPx,
    widthM,
    depthM,
    widthFt: width.feet,
    widthIn: width.inches,
    depthFt: depth.feet,
    depthIn: depth.inches,
    controllerCount: plan.controllerCount,
    packetsPerFrame: plan.packetsPerFrame,
    bytesPerFrame: plan.bytesPerFrame,
  };
}
