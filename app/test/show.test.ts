/**
 * The show file's parser, graded on what it refuses.
 *
 * `docs/APP-PLAN.md` makes the show file plain JSON so the renderer stays
 * replaceable. That only holds if the file is read as data rather than cast
 * into shape — a cast is not a contract, it is a hope, and the thing on the
 * other side of it goes on a floor in front of people.
 */

import { describe, it, expect } from 'vitest';
import { emptyShow, nextCueId, parseShow, serializeShow, SHOW_FILE_VERSION } from '../src/player/show';
import type { Show } from '../src/player/show';

const SHOP_FLOOR = { type: '8x8_4P', tileCols: 10, tileRows: 5 };

const SHOW: Show = {
  version: SHOW_FILE_VERSION,
  name: 'saturday-wedding',
  floor: SHOP_FLOOR,
  cues: [
    { id: 'cue-1', name: 'Doors / Warm', source: { kind: 'video', path: '/media/warm.mp4' }, durationMs: null },
    { id: 'cue-2', name: 'First Dance', source: { kind: 'video', path: '/media/dance.mp4' }, durationMs: 120_000 },
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

  it('refuses duplicate cue ids', () => {
    const cues = [SHOW.cues[0], { ...SHOW.cues[1], id: 'cue-1' }];
    expect(() => parseJson({ ...SHOW, cues })).toThrow(/duplicate cue id/);
  });

  it('refuses a source kind it cannot play', () => {
    const cues = [{ ...SHOW.cues[0], source: { kind: 'generator', path: 'plasma' } }];
    expect(() => parseJson({ ...SHOW, cues })).toThrow(/is not supported/);
  });

  it('refuses a duration that is neither null nor a positive number', () => {
    for (const durationMs of [0, -1, 'forever']) {
      expect(() => parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], durationMs }] })).toThrow(/durationMs/);
    }
    // NaN never survives `JSON.stringify` — it serialises as `null` — so this
    // case has to bypass the round-trip helper to reach the parser at all.
    // A parser that only ever sees JSON-clean input is not the one that runs
    // when something builds a show object in memory.
    expect(() => parseShow({ ...SHOW, cues: [{ ...SHOW.cues[0], durationMs: Number.NaN }] })).toThrow(/durationMs/);
  });

  it('refuses missing structure rather than reading it as undefined', () => {
    expect(() => parseShow(null)).toThrow(/not an object/);
    expect(() => parseShow([])).toThrow(/not an object/);
    expect(() => parseJson({ ...SHOW, cues: 'cue-1' })).toThrow(/not an array/);
    expect(() => parseJson({ ...SHOW, name: '' })).toThrow(/show.name/);
    expect(() => parseJson({ ...SHOW, floor: { ...SHOP_FLOOR, tileCols: 0 } })).toThrow(/tileCols/);
    expect(() => parseJson({ ...SHOW, cues: [{ ...SHOW.cues[0], source: { kind: 'video' } }] })).toThrow(/source.path/);
  });

  it('accepts a missing durationMs as a cue that holds until GO', () => {
    const { durationMs, ...withoutDuration } = SHOW.cues[0];
    expect(durationMs).toBe(null);
    expect(parseJson({ ...SHOW, cues: [withoutDuration] }).cues[0].durationMs).toBe(null);
  });
});
