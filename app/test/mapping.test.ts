/**
 * PR 3's off-UI gates: the Mapping surface's topology and its selection path.
 *
 * Two things are graded here, and they are graded against different oracles on
 * purpose.
 *
 *   - **Gate 1** grades the wiring diagram against `python -m mapper plan`,
 *     which is hardware-graded. `docs/MAPPING-DIAGRAM.md` is explicit that it
 *     "is not a source of truth about topology" — the controller count, the
 *     ports in use and the packet shape come from `mapper`. So the diagram
 *     *parses* that output; it never re-derives it, because
 *     `docs/APP-PLAN.md:180-186` calls a TypeScript reimplementation of the
 *     topology "a second implementation of the thing under test."
 *   - **Gate 3** grades the Floor panel's selection path against `JOB_RIG`, the
 *     object `gate.digest.test.ts` already hashes to `12df0afc…`. It drives
 *     `applyFloorSelection` — the function the three `<select>` `onChange`
 *     handlers actually call — rather than asserting `floorGeometry(...)`
 *     directly, which would exercise nothing UI-shaped at all.
 *
 * The one rule both obey: **where this file computes an expectation, it computes
 * it from the documented formula, not by calling the module under test.** The
 * tile-column expectation below is `mapper/frame.py:34`'s own
 * `divmod(tile_col, ports_per_controller)`, inverted, written out here. A test
 * that imported `buildDiagram`'s internals to check `buildDiagram` would be the
 * module asserting against itself.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePlanTable, type PlanTable } from '../src/mapping/mapperPlan';
import { buildDiagram, deriveReadout, portsPerController } from '../src/mapping/diagramLayout';
import { applyFloorSelection } from '../src/mapping/floorSelection';
import { floorGeometry, JOB_RIG, SHOP_RIG, TILE_PX } from '../src/render/geometry';
import type { ShowFloor } from '../src/player/show';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = process.env.DDF_PYTHON ?? 'python3';

/** `python -m mapper plan` for a geometry, verbatim. The only topology oracle. */
function mapperPlan(type: string, cols: number, rows: number): string {
  return execFileSync(
    PYTHON,
    ['-m', 'mapper', 'plan', '--type', type, '--cols', String(cols), '--rows', String(rows)],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 24 },
  );
}

const RIGS = [
  {
    name: 'shop · 10 x 5',
    type: '8x8_4P', cols: 10, rows: 5, packets: 20, bytes: 9_700, controllers: 3,
    // 4 / 4 / 2. CLAUDE.md records that split, and controller 3's two spare
    // sockets are what `MAPPING-DIAGRAM.md` says the diagram draws unwired.
    ports: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1]],
  },
  {
    name: 'job · 10 x 12',
    type: '8x8_4P', cols: 10, rows: 12, packets: 50, bytes: 23_290, controllers: 3,
    ports: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1]],
  },
  {
    // An `_8P` type, graded because the Floor panel offers it and `wire.mjs`
    // drives the running app through it. `MAPPING-DIAGRAM.md` says the `_8P`
    // edge layout is "not something PR 3 needs to get right" — but that is a
    // statement about the *vendor's* wide physical connectors, and `mapper`
    // is the authority here: `mapper/frame.py:34` gives one port per tile
    // column at every type, so ten columns take ten ports whatever the type.
    // Without this rig the assertions below only ever saw four ports per
    // controller and could not tell a per-type edge model from a wrong one.
    name: 'an 8-port type · 6x6_8P 10 x 5',
    type: '6x6_8P', cols: 10, rows: 5, packets: 20, bytes: 5_500, controllers: 2,
    ports: [[0, 1, 2, 3, 4, 5, 6, 7], [0, 1]],
  },
];

// ---------------------------------------------------------------------------
// Gate 1 — the diagram agrees with `mapper plan`, field for field
// ---------------------------------------------------------------------------

describe.each(RIGS)('gate 1 — $name topology comes from mapper plan', (rig) => {
  const stdout = mapperPlan(rig.type, rig.cols, rig.rows);
  const plan: PlanTable = parsePlanTable(stdout);

  it('parses the summary line', () => {
    expect(plan.type).toBe(rig.type);
    expect(plan.tileCols).toBe(rig.cols);
    expect(plan.tileRows).toBe(rig.rows);
    expect(plan.packetsPerFrame).toBe(rig.packets);
    expect(plan.bytesPerFrame).toBe(rig.bytes);
    expect(plan.controllerCount).toBe(rig.controllers);
  });

  it('parses every packet row', () => {
    // The positive control. Every per-row assertion below is a loop over
    // `plan.rows`, and a parser that returned an empty array would satisfy all
    // of them silently — CLAUDE.md's `allBlack([])` failure exactly. Assert the
    // count, not just the property.
    expect(plan.rows.length).toBe(rig.packets);

    const seen = new Set<number>();
    for (const row of plan.rows) {
      expect(row.idx).toBeGreaterThanOrEqual(0);
      expect(seen.has(row.idx)).toBe(false);
      seen.add(row.idx);
      expect(row.ctrl).toBeGreaterThanOrEqual(0);
      expect(row.port).toBeGreaterThanOrEqual(0);
      expect(row.len).toBeGreaterThan(0);
    }
    expect(plan.rows.reduce((sum, row) => sum + row.len, 0)).toBe(rig.bytes);
  });

  it('derives ports-in-use per controller from the table, not from arithmetic', () => {
    expect([...plan.portsByController.keys()].sort((a, b) => a - b))
      .toEqual(rig.ports.map((_, controller) => controller));
    rig.ports.forEach((ports, controller) => {
      expect(plan.portsByController.get(controller)).toEqual(ports);
    });
    // The count, not just the contents. An empty map would satisfy a forEach
    // over `rig.ports` only if `rig.ports` were empty too — but a map with the
    // right keys and short port lists would slip through without this.
    expect([...plan.portsByController.values()].flat().length).toBe(rig.cols);
  });

  it('assigns every (ctrl, port) to the tile column mapper puts it on', () => {
    const diagram = buildDiagram(rig.type, rig.cols, rig.rows, plan);
    const ppc = portsPerController(rig.type);

    // One wire per floor edge, and for a `_4P` type one edge per tile column.
    expect(diagram.wires.length).toBe(rig.cols);

    // The field-for-field check. Aggregate counts stay right under a reversed
    // or shifted column-to-port assignment, so counts alone cannot catch it.
    // `expectedCol` is `mapper/frame.py:34`'s divmod inverted, computed here.
    const wireFor = new Map(diagram.wires.map((w) => [`${w.controller}:${w.port}`, w]));
    let checked = 0;
    for (const row of plan.rows) {
      const wire = wireFor.get(`${row.ctrl}:${row.port}`);
      expect(wire, `no wire for controller ${row.ctrl} port ${row.port}`).toBeDefined();
      expect(wire!.tileCol).toBe(row.ctrl * ppc + row.port);
      checked += 1;
    }
    expect(checked).toBe(rig.packets);
  });

  it('gives every tile its floor-pixel origin', () => {
    const diagram = buildDiagram(rig.type, rig.cols, rig.rows, plan);
    const tilePx = TILE_PX[rig.type].tilePx;
    expect(diagram.tiles.length).toBe(rig.cols * rig.rows);
    for (const tile of diagram.tiles) {
      expect(tile.originXPx).toBe(tile.col * tilePx);
      expect(tile.originYPx).toBe(tile.row * tilePx);
    }
  });

  it('reads the derived readout off the floor and the plan, re-entering nothing', () => {
    const floor = floorGeometry(rig.type, rig.cols, rig.rows);
    const readout = deriveReadout(floor, plan);

    expect(readout.tileCount).toBe(rig.cols * rig.rows);
    expect(readout.widthPx).toBe(floor.widthPx);
    expect(readout.heightPx).toBe(floor.heightPx);
    expect(readout.controllerCount).toBe(plan.controllerCount);
    expect(readout.packetsPerFrame).toBe(plan.packetsPerFrame);
    expect(readout.bytesPerFrame).toBe(plan.bytesPerFrame);
    // A tile is 500 mm.
    expect(readout.widthM).toBeCloseTo(rig.cols * 0.5, 6);
    expect(readout.depthM).toBeCloseTo(rig.rows * 0.5, 6);
    // Feet come from the metres, not from a second conversion of the tile count.
    expect(readout.widthFt + readout.widthIn / 12).toBeCloseTo(readout.widthM / 0.3048, 2);
    expect(readout.depthFt + readout.depthIn / 12).toBeCloseTo(readout.depthM / 0.3048, 2);
  });
});

// ---------------------------------------------------------------------------
// The floor limits the app offers must be the ones mapper will accept
// ---------------------------------------------------------------------------

/** `mapper/floors.py`'s own limits, read from `mapper`, never transcribed. */
function mapperLimits(): { maxTileCols: number; maxTileRows: Record<string, number> } {
  const stdout = execFileSync(
    PYTHON,
    ['-c', 'import json;from mapper.floors import FLOOR_TYPES,MAX_TILE_COLS;'
      + 'print(json.dumps({"maxTileCols":MAX_TILE_COLS,'
      + '"maxTileRows":{k:v.max_tile_rows for k,v in FLOOR_TYPES.items()}}))'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

describe('the floor limits agree with mapper', () => {
  const limits = mapperLimits();

  it('offers exactly the types mapper has', () => {
    expect(Object.keys(TILE_PX).sort()).toEqual(Object.keys(limits.maxTileRows).sort());
  });

  it.each(Object.keys(limits.maxTileRows))('accepts %s up to mapper\'s row limit', (type) => {
    const maxRows = limits.maxTileRows[type];
    expect(maxRows).toBeGreaterThan(0);
    expect(() => floorGeometry(type, 1, maxRows)).not.toThrow();
    expect(() => floorGeometry(type, limits.maxTileCols, maxRows)).not.toThrow();
  });

  it.each(Object.keys(limits.maxTileRows))('refuses %s past mapper\'s row limit', (type) => {
    // The reason this matters is not tidiness. `doSetFloor` stops the running
    // sidecar and spawns a replacement, and it validates through
    // `floorGeometry` *first* precisely so an impossible selection rejects with
    // the old sender still alive. That guard is only as strong as this
    // validator: a row count `floorGeometry` waves through but `mapper` refuses
    // means the old sidecar is stopped, `mapper stream` exits on startup, and
    // the floor has no sender at all — controller 1 reverts to the vendor's own
    // content about five seconds later, mid-show.
    //
    // Per-type, and read from mapper rather than written here: the limits are
    // 25 / 17 / 22 / 11 today, and a table copied into TypeScript is a table
    // that drifts silently the first time `mapper` changes one.
    expect(() => floorGeometry(type, 1, limits.maxTileRows[type] + 1)).toThrow();
  });

  it('refuses more tile columns than mapper allows', () => {
    expect(() => floorGeometry('8x8_4P', limits.maxTileCols + 1, 1)).toThrow();
  });

  it('refuses the same geometries through the selection path the UI runs', () => {
    const base: ShowFloor = { type: '8x8_8P', tileCols: 10, tileRows: 5 };
    expect(() => applyFloorSelection(base, { tileRows: limits.maxTileRows['8x8_8P'] + 1 })).toThrow();
    expect(() => applyFloorSelection(base, { tileCols: limits.maxTileCols + 1 })).toThrow();
    // And a type change that makes the *existing* row count illegal. 12 rows is
    // legal on 8x8_4P (max 22) and not on 8x8_8P (max 11), so switching type
    // alone can invalidate a floor nobody edited the height of.
    const tall: ShowFloor = { type: '8x8_4P', tileCols: 10, tileRows: 12 };
    expect(() => applyFloorSelection(tall, { type: '8x8_8P' })).toThrow();
  });
});

describe('gate 1 — the parser refuses rather than guessing', () => {
  it('throws on output it cannot parse', () => {
    expect(() => parsePlanTable('')).toThrow();
    expect(() => parsePlanTable('mapper: error: unknown type\n')).toThrow();
  });

  it('knows both port counts', () => {
    expect(portsPerController('8x8_4P')).toBe(4);
    expect(portsPerController('6x6_4P')).toBe(4);
    expect(portsPerController('8x8_8P')).toBe(8);
    expect(portsPerController('6x6_8P')).toBe(8);
    expect(() => portsPerController('nonsense')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — the Floor panel's selection path reaches the job rig
// ---------------------------------------------------------------------------

describe('gate 3 — the selection path the UI actually runs', () => {
  it('reaches JOB_RIG by the three changes an operator makes', () => {
    // Driven the way the surface drives it: one patch per `<select>` change,
    // applied in sequence to the running value. Fails if Width is wired to
    // `tileRows` or Height to `tileCols` — the tautological version could not.
    let floor: ShowFloor = { type: SHOP_RIG.type, tileCols: 10, tileRows: 5 };
    floor = applyFloorSelection(floor, { type: '8x8_4P' });
    floor = applyFloorSelection(floor, { tileCols: 10 });
    floor = applyFloorSelection(floor, { tileRows: 12 });

    expect(floor).toEqual({ type: '8x8_4P', tileCols: 10, tileRows: 12 });
    expect(floorGeometry(floor.type, floor.tileCols, floor.tileRows)).toEqual(JOB_RIG);
  });

  it('distinguishes the two axes', () => {
    const base: ShowFloor = { type: '8x8_4P', tileCols: 10, tileRows: 5 };
    expect(applyFloorSelection(base, { tileCols: 12 })).toEqual({ ...base, tileCols: 12 });
    expect(applyFloorSelection(base, { tileRows: 12 })).toEqual({ ...base, tileRows: 12 });
  });

  it('validates before returning, so a bad selection never reaches setFloor', () => {
    // `doSetFloor` calls `floorGeometry` before stopping the running sidecar for
    // the same reason: an invalid selection must reject with the old floor
    // still live, not after it has been torn down.
    const base: ShowFloor = { type: '8x8_4P', tileCols: 10, tileRows: 5 };
    expect(() => applyFloorSelection(base, { type: 'nonsense' })).toThrow();
    expect(() => applyFloorSelection(base, { tileCols: 0 })).toThrow();
    expect(() => applyFloorSelection(base, { tileRows: -1 })).toThrow();
  });

  it('accepts every type the Floor panel offers', () => {
    // The Type dropdown is built from `TILE_PX`'s keys, and `APP-PLAN.md:164`
    // requires all four `mapper stream --type` values. `6x6_8P` was missing —
    // selecting it threw *after* the old sidecar had already stopped.
    expect(Object.keys(TILE_PX).sort()).toEqual(['6x6_4P', '6x6_8P', '8x8_4P', '8x8_8P']);
    const base: ShowFloor = { type: '8x8_4P', tileCols: 10, tileRows: 5 };
    for (const type of Object.keys(TILE_PX)) {
      expect(applyFloorSelection(base, { type }).type).toBe(type);
    }
  });
});
