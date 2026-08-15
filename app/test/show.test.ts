/**
 * The show file's parser, graded on what it refuses.
 *
 * `docs/APP-PLAN.md` makes the show file plain JSON so the renderer stays
 * replaceable. That only holds if the file is read as data rather than cast
 * into shape — a cast is not a contract, it is a hope, and the thing on the
 * other side of it goes on a floor in front of people.
 *
 * PR 3 deletes `durationMs` outright and bumps `SHOW_FILE_VERSION` to 2 —
 * `docs/APP-PLAN.md`'s "PR 3 — app-cue-timing" section says this is free
 * because nothing persists a show yet, so there is no migration to write and
 * no v1 file to read forward. A v1 show is refused, not reinterpreted.
 */

import { describe, it, expect } from 'vitest';
import { emptyShow, nextCueId, parseShow, serializeShow, SHOW_FILE_VERSION } from '../src/player/show';
import type { Cue, Show } from '../src/player/show';
import { cueNameFromPath, insertCue, renameCue, setCueRotation } from '../src/player/playHelpers';

const SHOP_FLOOR = { type: '8x8_4P', tileCols: 10, tileRows: 5 };

const SHOW: Show = {
  version: SHOW_FILE_VERSION,
  name: 'saturday-wedding',
  floor: SHOP_FLOOR,
  cues: [
    {
      id: 'cue-1',
      name: 'Doors / Warm',
      source: { kind: 'video', path: '/media/warm.mp4' },
      loop: null,
      trimStartMs: 0,
      trimEndMs: null,
      mediaDurationMs: null,
      rotation: 0,
    },
    {
      id: 'cue-2',
      name: 'First Dance',
      source: { kind: 'video', path: '/media/dance.mp4' },
      loop: 2,
      trimStartMs: 2_000,
      trimEndMs: 118_000,
      mediaDurationMs: 120_000,
      rotation: 90,
    },
  ],
};

function parseJson(value: unknown): Show {
  return parseShow(JSON.parse(JSON.stringify(value)));
}

describe('show file', () => {
  it('round-trips through serialize and parse', () => {
    expect(parseShow(JSON.parse(serializeShow(SHOW)))).toEqual(SHOW);
  });

  it('serializes with a trailing newline, so a show file is a well-formed text file', () => {
    expect(serializeShow(SHOW).endsWith('}\n')).toBe(true);
  });

  it('holds nothing measured in floor pixels', () => {
    // Geometry is an output format. A stored floor-pixel value would have to be
    // migrated when a show authored on the shop rig opens on the job rig, and
    // PR 5's auto-fit is a re-render only because nothing here is in floor units.
    expect(JSON.stringify(SHOW)).not.toMatch(/\b(80|40|96)\b/);
  });

  it('starts empty with the current version', () => {
    const show = emptyShow(SHOP_FLOOR);
    expect(show.version).toBe(SHOW_FILE_VERSION);
    expect(show.cues).toEqual([]);
    expect(parseShow(JSON.parse(serializeShow(show)))).toEqual(show);
  });

  it('is version 2', () => {
    // Not a tautology: this pins the number so a future bump has to change this
    // line deliberately, rather than the "refuses a version it does not know"
    // test below silently grading whatever `SHOW_FILE_VERSION` happens to hold.
    expect(SHOW_FILE_VERSION).toBe(2);
  });

  /**
   * The writer and the reader, graded against each other.
   *
   * Every other test in this file feeds the parser a show that this file wrote,
   * which means the parser has only ever been checked against its own author's
   * idea of a show. Nothing had established that the *app* builds one it can
   * read back — and the app does not use the literal above, it assembles cues in
   * `addMedia` out of `nextCueId`, `cueNameFromPath` and a picker path, then
   * edits them through the `playHelpers` functions.
   *
   * So this walks that exact path and requires the result to survive the round
   * trip. It is the coupling PR 5 depends on: Save writes whatever the app is
   * holding, Open runs it through `parseShow`, and a field the app can produce
   * but the parser refuses is a show that saves and will not reopen.
   *
   * Only add/rotate/rename are exercised here, deliberately. Loop and trim gain
   * no editing UI in PR 3's engine half — `docs/APP-PLAN.md`'s "the inspector
   * and trim-mode UI wait" — so this reflects what the app can actually build a
   * cue out of right now. It will grow a loop/trim edit once that UI lands.
   */
  it('reparses a show assembled the way the app assembles one', () => {
    const picked = [
      '/Users/rob/Movies/Doors — Warm.mp4',
      '/Users/rob/Movies/first dance (final).mov',
      '/Volumes/SD/loop.webm',
    ];

    let cues: readonly Cue[] = [];
    for (const path of picked) {
      cues = insertCue(cues, {
        id: nextCueId(cues),
        name: cueNameFromPath(path),
        source: { kind: 'video', path },
        loop: null,
        trimStartMs: 0,
        trimEndMs: null,
        mediaDurationMs: null,
        rotation: 0,
      });
    }
    cues = setCueRotation(cues, 'cue-3', 270);
    cues = renameCue(cues, 'cue-3', 'Last Song');

    const built: Show = { ...emptyShow(SHOP_FLOOR, 'Untitled show'), cues };
    expect(parseShow(JSON.parse(serializeShow(built)))).toEqual(built);
  });

  it('names a cue something the parser will accept, for every path the picker can return', () => {
    // `asString` refuses an empty name, so a `cueNameFromPath` that can return
    // one is a show the app builds and cannot reopen. The native dialog returns
    // files, but `DDF_PICK_MEDIA` — the wire gate's seam into the same code —
    // is a delimiter-split string, and a stray trailing delimiter yields ''.
    for (const path of ['/media/clip.mp4', 'C:\\clips\\a.mov', '.mp4', 'noext', '/media/', '']) {
      const name = cueNameFromPath(path);
      const cue: Cue = {
        id: 'cue-1',
        name,
        source: { kind: 'video', path: path || '/x.mp4' },
        loop: null,
        trimStartMs: 0,
        trimEndMs: null,
        mediaDurationMs: null,
        rotation: 0,
      };
      expect(() => parseShow({ ...emptyShow(SHOP_FLOOR), cues: [cue] })).not.toThrow();
    }
  });

  it('mints cue ids that do not collide with the ones already in the stack', () => {
    expect(nextCueId([])).toBe('cue-1');
    expect(nextCueId(SHOW.cues)).toBe('cue-3');
    // Ids survive deletion, so the count is a starting point rather than an answer.
    expect(nextCueId([{ ...SHOW.cues[0], id: 'cue-3' }])).toBe('cue-2');
  });

  it('refuses a version it does not know rather than guessing', () => {
    expect(() => parseJson({ ...SHOW, version: SHOW_FILE_VERSION + 1 })).toThrow(/version/);
    expect(() => parseJson({ ...SHOW, version: 'one' })).toThrow(/version/);
  });

  /**
   * The specific backward-incompatible case, not just "an unknown version".
   * A v1 file's cues carry `durationMs` and none of `loop`/`trimStartMs`/
   * `trimEndMs`/`mediaDurationMs` — the exact shape this repo's own users would
   * have on disk the day this PR merges, if anything persisted a show yet.
   * Nothing does (`docs/APP-PLAN.md`), which is what makes the bump free — but
   * the refusal itself is still worth pinning down by name.
   */
  it('refuses a v1 show rather than reading durationMs as something it is not', () => {
    const v1 = {
      version: 1,
      name: SHOW.name,
      floor: SHOP_FLOOR,
      cues: [{ id: 'cue-1', name: 'Old', source: { kind: 'video', path: '/media/old.mp4' }, durationMs: null, rotation: 0 }],
    };
    expect(() => parseShow(v1)).toThrow(/version/);
  });

  it('refuses duplicate cue ids', () => {
    const cues = [SHOW.cues[0], { ...SHOW.cues[1], id: 'cue-1' }];
    expect(() => parseJson({ ...SHOW, cues })).toThrow(/duplicate cue id/);
  });

  it('refuses a source kind it cannot play', () => {
    const cues = [{ ...SHOW.cues[0], source: { kind: 'generator', path: 'plasma' } }];
    expect(() => parseJson({ ...SHOW, cues })).toThrow(/is not supported/);
  });

  it('refuses missing structure rather than reading it as undefined', () => {
    expect(() => parseShow(null)).toThrow(/not an object/);
    expect(() => parseShow([])).toThrow(/not an object/);
    expect(() => parseJson({ ...SHOW, cues: 'cue-1' })).toThrow(/not an array/);
    expect(() => parseJson({ ...SHOW, name: '' })).toThrow(/show.name/);
    expect(() => parseJson({ ...SHOW, floor: { ...SHOP_FLOOR, tileCols: 0 } })).toThrow(/tileCols/);
    expect(() => parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], source: { kind: 'video' } }] })).toThrow(/source.path/);
  });

  // ---------------------------------------------------------------- rotation

  it('defaults a missing rotation to 0, so shows saved before this field exists still open', () => {
    const { rotation, ...withoutRotation } = SHOW.cues[0];
    expect(rotation).toBe(0);
    expect(parseJson({ ...SHOW, cues: [withoutRotation] }).cues[0].rotation).toBe(0);
  });

  it('accepts every rotation Mapping offers', () => {
    for (const rotation of [0, 90, 180, 270]) {
      expect(parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], rotation }] }).cues[0].rotation).toBe(rotation);
    }
  });

  it('refuses a rotation that is not 0, 90, 180 or 270', () => {
    for (const rotation of [45, -90, 360, 'ninety', Number.NaN]) {
      expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], rotation }] })).toThrow(/rotation/);
    }
  });

  // --------------------------------------------------------------------- loop

  it('defaults a missing loop to null, so a cue holds until GO unless told otherwise', () => {
    const { loop, ...withoutLoop } = SHOW.cues[0];
    expect(loop).toBe(null);
    expect(parseJson({ ...SHOW, cues: [withoutLoop] }).cues[0].loop).toBe(null);
  });

  it('accepts null and every positive integer loop count', () => {
    for (const loop of [null, 1, 2, 30]) {
      expect(parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], loop }] }).cues[0].loop).toBe(loop);
    }
  });

  it('refuses a loop that is not null or a positive integer', () => {
    for (const loop of [0, -1, 1.5, 'twice', Number.NaN]) {
      expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], loop }] })).toThrow(/loop/);
    }
  });

  // -------------------------------------------------------------------- trim

  it('defaults a missing trimStartMs to 0 and trimEndMs to null (play to the end of the media)', () => {
    const { trimStartMs, trimEndMs, ...withoutTrim } = SHOW.cues[0];
    expect(trimStartMs).toBe(0);
    expect(trimEndMs).toBe(null);
    const parsed = parseJson({ ...SHOW, cues: [withoutTrim] }).cues[0];
    expect(parsed.trimStartMs).toBe(0);
    expect(parsed.trimEndMs).toBe(null);
  });

  it('accepts a trim range and an open one', () => {
    const bounded = parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 1_000, trimEndMs: 5_000 }] }).cues[0];
    expect(bounded.trimStartMs).toBe(1_000);
    expect(bounded.trimEndMs).toBe(5_000);

    const open = parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 1_000, trimEndMs: null }] }).cues[0];
    expect(open.trimEndMs).toBe(null);
  });

  it('refuses a trimStartMs that is negative or not a number', () => {
    for (const trimStartMs of [-1, 'zero', Number.NaN]) {
      expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs }] })).toThrow(/trimStartMs/);
    }
  });

  it('accepts a trimStartMs of exactly 0', () => {
    expect(parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 0 }] }).cues[0].trimStartMs).toBe(0);
  });

  it('refuses a trimEndMs that is not null or a positive number', () => {
    for (const trimEndMs of [0, -1, 'end', Number.NaN]) {
      expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 0, trimEndMs }] })).toThrow(/trimEndMs/);
    }
  });

  it('refuses a trimEndMs at or before trimStartMs', () => {
    expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 5_000, trimEndMs: 5_000 }] }))
      .toThrow(/trimEndMs/);
    expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], trimStartMs: 5_000, trimEndMs: 4_000 }] }))
      .toThrow(/trimEndMs/);
  });

  // ------------------------------------------------------------- media duration

  it('defaults a missing mediaDurationMs to null, meaning not probed or the probe failed', () => {
    const { mediaDurationMs, ...withoutDuration } = SHOW.cues[0];
    expect(mediaDurationMs).toBe(null);
    expect(parseJson({ ...SHOW, cues: [withoutDuration] }).cues[0].mediaDurationMs).toBe(null);
  });

  it('accepts a probed mediaDurationMs', () => {
    expect(parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], mediaDurationMs: 45_000 }] }).cues[0].mediaDurationMs)
      .toBe(45_000);
  });

  it('refuses a mediaDurationMs that is neither null nor a positive number', () => {
    for (const mediaDurationMs of [0, -1, 'unknown', Number.NaN]) {
      expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], mediaDurationMs }] })).toThrow(/mediaDurationMs/);
    }
  });
});
