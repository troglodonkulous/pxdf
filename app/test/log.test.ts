import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../electron/log';

/**
 * The log file, graded off-hardware.
 *
 * `createLogger` takes its directory rather than reaching for
 * `app.getPath('logs')` precisely so this file can exist: an Electron import
 * here would make the only durable error channel in the app gradeable solely by
 * running the app, which is the state that let the last job's playback problems
 * go undiagnosed.
 *
 * Two of these tests are about the instrument being broken rather than the
 * thing it measures — a logger that cannot write, and a logger asked to record
 * something multi-line. Both are cases where the tempting implementation reads
 * as working: a `catch {}` around the append, and a raw `\n` that silently
 * turns one event into what looks like several.
 */
describe('createLogger', () => {
  const made: string[] = [];

  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ddf-log-'));
    made.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of made.splice(0)) {
      // Restore write permission first: the failure test removes it, and
      // `rmSync` cannot empty a directory it may not write to.
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Already gone or already writable.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the directory it was given', () => {
    // Electron's docs say `logs` is "the directory for your app's log folder",
    // which is not the same as a promise that it exists. Assuming it does is one
    // `ENOENT` away from an app whose only error channel never opens.
    const dir = join(scratch(), 'nested', 'logs');
    const logger = createLogger(dir);
    logger.log('INFO', 'launch', 'hello');

    expect(readFileSync(logger.path, 'utf8')).toContain('hello');
  });

  it('writes one greppable record per event', () => {
    const logger = createLogger(scratch());
    logger.log('INFO', 'sidecar', 'spawned');
    logger.log('ERROR', 'sidecar', 'died');

    const lines = readFileSync(logger.path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z {2}INFO {3}sidecar {2}spawned$/);
    expect(lines[1]).toMatch(/ {2}ERROR {2}sidecar {2}died$/);
  });

  it('indents a multi-line message so it stays one record', () => {
    // A Python traceback is the motivating case, and it arrives whole from
    // `mapper`'s `traceback.print_exc()`. Written raw it would read as four
    // events with no timestamp on three of them; indented, every record still
    // begins with a digit and `grep '^2'` still counts events correctly.
    const logger = createLogger(scratch());
    logger.log('ERROR', 'sidecar', 'Traceback (most recent call last):\n  File "x.py"\nOSError');

    const text = readFileSync(logger.path, 'utf8');
    const records = text.trimEnd().split('\n').filter((line) => /^\d/.test(line));
    expect(records).toHaveLength(1);
    expect(text).toContain('\n      File "x.py"');
  });

  it('keeps the previous run and starts the new one clean', () => {
    // Rotation is by run, not by size. When something goes wrong at a venue the
    // operator restarts the app, and the file anyone wants is the one from the
    // launch before this one — a size policy would routinely discard it
    // mid-session.
    const dir = scratch();
    const first = createLogger(dir);
    first.log('INFO', 'launch', 'run one');

    const second = createLogger(dir);
    second.log('INFO', 'launch', 'run two');

    expect(readFileSync(second.path, 'utf8')).not.toContain('run one');
    expect(readFileSync(join(dir, 'ddf.prev.log'), 'utf8')).toContain('run one');
  });

  it('rotates over an older previous run rather than accumulating files', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'ddf.prev.log'), 'ancient\n');
    writeFileSync(join(dir, 'ddf.log'), 'recent\n');

    createLogger(dir).log('INFO', 'launch', 'current');

    expect(readFileSync(join(dir, 'ddf.prev.log'), 'utf8')).toBe('recent\n');
  });

  it('reports a write it could not make instead of swallowing it', () => {
    // The whole point of this change is removing channels that read as healthy
    // while carrying nothing, so the logger must not become one. A read-only
    // log directory is the realistic case — a `.app` in `/Applications` under a
    // managed profile, or a full disk.
    const dir = scratch();
    mkdirSync(join(dir, 'logs'));
    const logsDir = join(dir, 'logs');
    const logger = createLogger(logsDir);
    chmodSync(logsDir, 0o500);
    made.push(logsDir);

    logger.log('ERROR', 'sidecar', 'died');

    expect(logger.writeError).not.toBeNull();
  });

  it('has no write error on the happy path', () => {
    // The positive control for the test above: `writeError` being non-null must
    // mean something, which requires that it is null when the logger works.
    const logger = createLogger(scratch());
    logger.log('INFO', 'launch', 'fine');

    expect(logger.writeError).toBeNull();
  });
});
