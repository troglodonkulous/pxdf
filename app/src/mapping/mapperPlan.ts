/** One packet row emitted by `mapper plan`. */
export interface PlanRow {
  readonly idx: number;
  readonly ctrl: number;
  readonly port: number;
  readonly pkt: number;
  readonly byte4: number;
  readonly len: number;
  readonly portOff: number;
}

/** Parsed topology and frame sizing owned by `mapper`. */
export interface PlanTable {
  readonly type: string;
  readonly tileCols: number;
  readonly tileRows: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly controllerCount: number;
  readonly packetsPerFrame: number;
  readonly bytesPerFrame: number;
  readonly rows: readonly PlanRow[];
  /** Controller index -> its port indices actually in use, ascending. */
  readonly portsByController: ReadonlyMap<number, readonly number[]>;
}

const HEADER = /^(\S+)\s+(\d+)x(\d+)\s+tiles\s*=\s*(\d+)x(\d+)\s+px,\s*(\d+)\s+controller\(s\),\s*(\d+)\s+packets\/frame,\s*(\d+)\s+bytes\/frame$/;
const COLUMN_HEADER = /^idx\s+ctrl\s+port\s+pkt\s+byte4\s+len\s+portOff$/;
const ROW = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+0x([\da-fA-F]{2})\s+(\d+)\s+(\d+)$/;
const FOOTER = /^(\d+)\s+packets,\s*(\d+)\s+bytes\/frame,\s*(\d+)\s+end-of-frame flag\(s\)$/;

function fail(what: string): never {
  throw new Error(`invalid mapper plan: ${what}`);
}

function decimal(value: string, what: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${what} is not a safe integer`);
  return parsed;
}

/**
 * Parse `mapper plan` stdout strictly. Both summaries are checked so truncated
 * sidecar output cannot look like a valid, partially populated topology.
 */
export function parsePlanTable(stdout: string): PlanTable {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const header = lines[0]?.match(HEADER);
  if (header === undefined || header === null) fail('missing header summary');
  if (lines[1] === undefined || !COLUMN_HEADER.test(lines[1])) fail('missing packet column header');

  const footerLine = lines.at(-1);
  const footer = footerLine?.match(FOOTER);
  if (footer === undefined || footer === null) fail('missing footer summary');

  const type = header[1];
  const tileCols = decimal(header[2], 'tile columns');
  const tileRows = decimal(header[3], 'tile rows');
  const widthPx = decimal(header[4], 'pixel width');
  const heightPx = decimal(header[5], 'pixel height');
  const controllerCount = decimal(header[6], 'controller count');
  const packetsPerFrame = decimal(header[7], 'packet count');
  const bytesPerFrame = decimal(header[8], 'byte count');
  if (tileCols < 1 || tileRows < 1 || widthPx < 1 || heightPx < 1) fail('non-positive floor geometry');
  if (controllerCount < 1 || packetsPerFrame < 1 || bytesPerFrame < 1) fail('non-positive plan summary');

  const rows = lines.slice(2, -1).map((line, index): PlanRow => {
    const match = line.match(ROW);
    if (match === null) fail(`malformed packet row ${index}`);
    const row: PlanRow = {
      idx: decimal(match[1], `row ${index} index`),
      ctrl: decimal(match[2], `row ${index} controller`),
      port: decimal(match[3], `row ${index} port`),
      pkt: decimal(match[4], `row ${index} packet`),
      byte4: Number.parseInt(match[5], 16),
      len: decimal(match[6], `row ${index} length`),
      portOff: decimal(match[7], `row ${index} port offset`),
    };
    if (row.ctrl >= controllerCount) fail(`row ${index} names controller ${row.ctrl}`);
    if (row.len < 1) fail(`row ${index} has a non-positive length`);
    return row;
  });

  if (rows.length !== packetsPerFrame) {
    fail(`packet row count ${rows.length} does not match summary ${packetsPerFrame}`);
  }

  const indices = new Set(rows.map((row) => row.idx));
  if (indices.size !== rows.length) fail('packet row indices are not unique');
  const rowBytes = rows.reduce((sum, row) => sum + row.len, 0);
  if (!Number.isSafeInteger(rowBytes) || rowBytes !== bytesPerFrame) {
    fail(`packet row bytes ${rowBytes} do not match summary ${bytesPerFrame}`);
  }

  const footerPackets = decimal(footer[1], 'footer packet count');
  const footerBytes = decimal(footer[2], 'footer byte count');
  const endFlags = decimal(footer[3], 'end-of-frame flag count');
  if (footerPackets !== packetsPerFrame || footerBytes !== bytesPerFrame) {
    fail('header and footer summaries disagree');
  }
  if (endFlags !== controllerCount) fail('end-of-frame flag count does not match controller count');

  const portSets = new Map<number, Set<number>>();
  for (const row of rows) {
    const ports = portSets.get(row.ctrl) ?? new Set<number>();
    ports.add(row.port);
    portSets.set(row.ctrl, ports);
  }
  const portsByController = new Map<number, readonly number[]>(
    [...portSets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([controller, ports]) => [controller, [...ports].sort((left, right) => left - right)]),
  );

  return {
    type,
    tileCols,
    tileRows,
    widthPx,
    heightPx,
    controllerCount,
    packetsPerFrame,
    bytesPerFrame,
    rows,
    portsByController,
  };
}
