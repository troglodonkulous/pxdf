import { floorGeometry, type FloorGeometry } from '../render/geometry';
import type { PlanTable } from './mapperPlan';

/**
 * One cable, from one physical jack to the tile columns it feeds.
 *
 * A jack is not a port. `mapper` deals only in ports — one port drives exactly
 * one tile column, at every floor type — and this diagram deals in the thing an
 * operator actually plugs, which carries two of them.
 */
export interface DiagramWire {
  readonly controller: number;
  /** Physical socket on the back panel, 0..3. */
  readonly jack: number;
  /** The one or two logical ports this jack carries. */
  readonly ports: readonly number[];
  /** The tile columns those ports drive — adjacent, and as many as the ports. */
  readonly tileCols: readonly number[];
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
  /** Always four, whatever the type: the sockets on the physical back panel. */
  readonly jacks: readonly {
    readonly jack: number;
    /** True when either of this jack's two ports carries a chain. */
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

/** Physical RJ45 sockets on a controller's back panel. `docs/PROTOCOL.md:34`. */
const JACKS_PER_CONTROLLER = 4;
/** Logical ports one jack carries over one cable. `docs/PROTOCOL.md:35`. */
const PORTS_PER_JACK = 2;

/**
 * One floor edge per *jack*, spanning the columns that jack's ports drive.
 *
 * Port and jack are different objects and this diagram is about the second.
 * `mapper/frame.py:34` assigns ports as `divmod(tile_col, ports_per_controller)`
 * — one port per tile column, at every type, and nothing here changes that. But
 * a port is not something anyone plugs. `docs/PROTOCOL.md:75-79` settled the
 * physical pairing at gate 4 and confirmed it twice: "Connector 1 drives ports 0
 * and 1; connector 2 drives ports 2 and 3", and the cable trace at
 * `docs/RUNSHEET-10x5-4P.md:1546-1560` counted "5 connectors populated
 * ({2,2,1})" on the ten-column shop rig. Five cables, not ten.
 *
 * An earlier version of this function returned one edge per column and argued
 * from the divmod that pairing "left half the floor with no visible feed". The
 * premise was true and the conclusion was not: a paired edge is *wide*, spanning
 * both of its columns, so every column keeps a visible feed and there are half
 * as many cables. That is what the vendor's own 90x12 `LargePowerEdgeElement`
 * is for.
 *
 * Note this deliberately departs from Ledset at `_4P`. `LedSet.decompiled.cs`
 * `GetEdgeList()` branches on the floor-type enum and hands the two `_4P` types
 * one narrow edge per column — the vendor draws its `_4P` diagram port-wise,
 * which does not match the floor its own hardware ships. The cable trace wins.
 *
 * An odd trailing column yields a one-wide group with no branch: the last jack
 * simply has one port instead of two.
 */
function edgeColumns(tileCols: number, portsPerControllerCount: number): readonly (readonly number[])[] {
  const groups: number[][] = [];
  for (let col = 0; col < tileCols; col += 1) {
    const port = col % portsPerControllerCount;
    // A new group starts at each controller boundary and each jack boundary.
    if (port % PORTS_PER_JACK === 0) groups.push([col]);
    else groups[groups.length - 1].push(col);
  }
  return groups;
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
  if (portCount > JACKS_PER_CONTROLLER * PORTS_PER_JACK) {
    // A type with more ports than the back panel can carry would silently draw
    // only the first four jacks' worth of cables, and the floor would look
    // fully fed while half of it had no route. Refuse instead.
    throw new Error(
      `${type} has ${portCount} ports, more than ${JACKS_PER_CONTROLLER} jacks x ${PORTS_PER_JACK} can carry`,
    );
  }
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
    const jacks = Array.from({ length: JACKS_PER_CONTROLLER }, (_, jack) => {
      if (usedPorts.some((usedPort) => usedPort >= portCount)) {
        throw new Error(`mapper plan names a port outside ${type}`);
      }
      return {
        jack,
        used: usedPorts.some((usedPort) => Math.floor(usedPort / PORTS_PER_JACK) === jack),
        // Vendor coordinates name a socket's corner; wires need its centre.
        // Four sockets at a 15px pitch fit the 80px box at every type — an
        // eight-socket row did not, and its last three fell outside it.
        x: x + 17 + jack * 15,
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
      jacks,
    };
  });

  const edgeColumnGroups = edgeColumns(tileCols, portCount);
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
    const controller = Math.floor(edge.tileCols[0] / portCount);
    const ports = edge.tileCols.map((tileCol) => tileCol % portCount);
    const jack = Math.floor(ports[0] / PORTS_PER_JACK);
    ports.forEach((port, i) => {
      if (!plan.portsByController.get(controller)?.includes(port)) {
        throw new Error(`mapper plan has no route for tile column ${edge.tileCols[i]}`);
      }
    });
    const socket = controllers[controller]?.jacks[jack];
    if (socket === undefined) {
      throw new Error(`mapper plan route for tile column ${edge.tileCols[0]} is out of range`);
    }
    return {
      controller,
      jack,
      ports,
      tileCols: edge.tileCols,
      // Indexed by jack, which is 0..3 by construction. Indexing by port let
      // ports 0 and 4 of an `_8P` controller share both, and their cables drew
      // on top of each other.
      colorIndex: jack,
      dropHeight: 70 + 10 * jack,
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
