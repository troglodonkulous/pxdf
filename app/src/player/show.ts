import type { Rotation } from '../render/geometry'

/**
 * The show file, and the only definition of what a cue is.
 *
 * Two rules from `docs/APP-PLAN.md` shape this module, and both cost nothing
 * today but stop being cheap later:
 *
 *   - **The show file is plain JSON.** No DOM types, no Electron types, no
 *     handles into anything that only exists inside a running renderer. The
 *     renderer is meant to be replaceable — the WebGL pass in `APP-PLAN`'s
 *     "when this becomes wrong" section is the near case — and a show file that
 *     can only be read by the renderer that wrote it makes that a rewrite.
 *   - **Nothing here is measured in floor pixels.** Geometry lives in
 *     `render/geometry.ts` and is an output format. A show authored on the shop
 *     rig has to open on the job rig, and PR 5's auto-fit is a re-render rather
 *     than a migration only if no stored number is in floor units.
 *
 * A cue in PR 2 is a media file and a duration. PR 4 gives it a layer stack;
 * the parser below is written so that adding `layers` later is an additive
 * change to `Cue` and a version bump, not a reinterpretation of what exists.
 */

/**
 * Bumped whenever a stored show stops being readable by the previous parser.
 * `parseShow` refuses a version it does not know rather than guessing: a show
 * file half-understood is worse than one that will not open, because the half
 * that was understood goes on the floor.
 */
export const SHOW_FILE_VERSION = 2;

export interface CueSource {
  /** Only `video` in PR 2. Generators and text are PR 5. */
  readonly kind: 'video';
  /**
   * Path to the media file, as the operator's machine sees it. PR 5 owns
   * project files and will make this relative to the show file; until then it
   * is stored verbatim and a missing file surfaces as a failed cue at GO
   * rather than as a parse error, because a show that will not open is worse
   * at a wedding than one cue that will not run.
   */
  readonly path: string;
}

export interface Cue {
  readonly id: string;
  readonly name: string;
  readonly source: CueSource;
  /** null = holds until GO (default). N >= 1 = play the trimmed clip N times, then advance. */
  readonly loop: number | null;
  /** In-point, milliseconds. Default 0. */
  readonly trimStartMs: number;
  /** Out-point, milliseconds. null = play to the end of the media. */
  readonly trimEndMs: number | null;
  /** Probed once at add time via probeDurationMs. null = not probed yet, or the probe failed. */
  readonly mediaDurationMs: number | null;
  /** Per-cue compensation for Mapping's floor Rotation, independent of `mapper/orientation.py`. */
  readonly rotation: Rotation;
}

/**
 * The trimmed clip's own length, independent of loop. `trimEndMs ??
 * mediaDurationMs` is the out-point. Unknown or non-positive results stay
 * null: an asynchronous probe may not have landed yet.
 */
export function clipDurationMs(cue: Cue): number | null {
  const end = cue.trimEndMs ?? cue.mediaDurationMs;
  if (end === null) return null;
  const duration = end - cue.trimStartMs;
  return duration > 0 ? duration : null;
}

/**
 * How long the cue holds before the stack advances on its own. null means do
 * not advance: either loop is null or the clip length is not known yet.
 */
export function cueHoldMs(cue: Cue): number | null {
  if (cue.loop === null) return null;
  const duration = clipDurationMs(cue);
  return duration === null ? null : cue.loop * duration;
}

export interface ShowFloor {
  readonly type: string;
  readonly tileCols: number;
  readonly tileRows: number;
}

export interface Show {
  readonly version: number;
  readonly name: string;
  readonly floor: ShowFloor;
  readonly cues: readonly Cue[];
}

export function emptyShow(floor: ShowFloor, name = 'Untitled show'): Show {
  return { version: SHOW_FILE_VERSION, name, floor, cues: [] };
}

/** A cue id that does not collide with anything already in the stack. */
export function nextCueId(cues: readonly Cue[]): string {
  let n = cues.length + 1;
  const taken = new Set(cues.map((cue) => cue.id));
  while (taken.has(`cue-${n}`)) n += 1;
  return `cue-${n}`;
}

function fail(what: string): never {
  throw new Error(`invalid show file: ${what}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${what} is not a non-empty string`);
  return value;
}

function asPositiveInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(`${what} is not a positive integer`);
  return value;
}

function asRotation(value: unknown, what: string): Rotation {
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) {
    fail(`${what} is not 0, 90, 180 or 270`);
  }
  return value;
}

function parseCue(value: unknown, index: number, seen: Set<string>): Cue {
  const raw = asRecord(value, `cues[${index}]`);
  const id = asString(raw.id, `cues[${index}].id`);
  if (seen.has(id)) fail(`duplicate cue id ${JSON.stringify(id)}`);
  seen.add(id);

  const source = asRecord(raw.source, `cues[${index}].source`);
  if (source.kind !== 'video') fail(`cues[${index}].source.kind ${JSON.stringify(source.kind)} is not supported`);

  const loop = raw.loop ?? null;
  if (loop !== null && (typeof loop !== 'number' || !Number.isInteger(loop) || loop < 1)) {
    fail(`cues[${index}].loop is neither null nor a positive integer`);
  }
  const trimStartMs = raw.trimStartMs ?? 0;
  if (typeof trimStartMs !== 'number' || !Number.isFinite(trimStartMs) || trimStartMs < 0) {
    fail(`cues[${index}].trimStartMs is not a non-negative finite number`);
  }
  const trimEndMs = raw.trimEndMs ?? null;
  if (trimEndMs !== null && (typeof trimEndMs !== 'number' || !Number.isFinite(trimEndMs) || trimEndMs <= 0)) {
    fail(`cues[${index}].trimEndMs is neither null nor a positive finite number`);
  }
  if (trimEndMs !== null && trimEndMs <= trimStartMs) {
    fail(`cues[${index}].trimEndMs must be greater than trimStartMs`);
  }
  const mediaDurationMs = raw.mediaDurationMs ?? null;
  if (mediaDurationMs !== null && (typeof mediaDurationMs !== 'number' || !Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0)) {
    fail(`cues[${index}].mediaDurationMs is neither null nor a positive finite number`);
  }

  return {
    id,
    name: asString(raw.name, `cues[${index}].name`),
    source: { kind: 'video', path: asString(source.path, `cues[${index}].source.path`) },
    loop: loop as number | null,
    trimStartMs,
    trimEndMs: trimEndMs as number | null,
    mediaDurationMs: mediaDurationMs as number | null,
    rotation: asRotation(raw.rotation ?? 0, `cues[${index}].rotation`),
  };
}

/**
 * Parse a show from `JSON.parse` output.
 *
 * Every field is checked rather than cast. The alternative — trusting the file
 * because the app wrote it — is how a hand-edited or half-written show reaches
 * the player as `undefined` and puts a frame of garbage on a floor in front of
 * people. It costs one traversal of a file that has tens of cues in it.
 */
export function parseShow(value: unknown): Show {
  const raw = asRecord(value, 'show');
  const version = asPositiveInt(raw.version, 'show.version');
  if (version !== SHOW_FILE_VERSION) fail(`version ${version} is not ${SHOW_FILE_VERSION}`);

  const floor = asRecord(raw.floor, 'show.floor');
  const cuesRaw = raw.cues;
  if (!Array.isArray(cuesRaw)) fail('show.cues is not an array');

  const seen = new Set<string>();
  return {
    version,
    name: asString(raw.name, 'show.name'),
    floor: {
      type: asString(floor.type, 'show.floor.type'),
      tileCols: asPositiveInt(floor.tileCols, 'show.floor.tileCols'),
      tileRows: asPositiveInt(floor.tileRows, 'show.floor.tileRows'),
    },
    cues: cuesRaw.map((cue, index) => parseCue(cue, index, seen)),
  };
}

/** The show as it is written to disk. Round-trips through `parseShow`. */
export function serializeShow(show: Show): string {
  return `${JSON.stringify(show, null, 2)}\n`;
}
