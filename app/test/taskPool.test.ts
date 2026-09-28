/**
 * The concurrency limiter behind `PlayScreen`'s two per-cue fan-outs, graded on
 * the three things that can go wrong with a pool — and each of them is graded
 * against its own opposite, because every one of the three has a degenerate
 * implementation that satisfies it alone.
 *
 * - "Never exceeds the limit" is satisfied by a pool that runs nothing, so
 *   every case that bounds concurrency also asserts the work finished.
 * - "Drains" is satisfied by a pool with no limit at all, so the draining
 *   cases assert the observed concurrency as well as the results.
 * - "Starts promptly" is satisfied by the unbounded pool this file exists to
 *   replace, so it is asserted at a width, not as "more than one".
 *
 * Concurrency is observed the way the operator's machine observes it — by
 * counting tasks that have started and not finished — rather than by reading a
 * counter off the pool. A pool that miscounts its own slots would agree with
 * itself; `CLAUDE.md`'s rule is to grade the consequence, not the internal
 * symptom.
 */

import { describe, expect, it } from 'vitest'
import { createTaskPool } from '../src/player/taskPool'

/** A task whose completion the test controls, plus a live concurrency census. */
function tracker() {
  let active = 0
  let peak = 0
  const started: number[] = []
  const gates: ((value: string) => void)[] = []
  const failures: ((reason: Error) => void)[] = []

  const task = (id: number) => async (): Promise<string> => {
    active += 1
    if (active > peak) peak = active
    started.push(id)
    try {
      return await new Promise<string>((resolve, reject) => {
        gates[id] = resolve
        failures[id] = reject
      })
    } finally {
      active -= 1
    }
  }

  return {
    task,
    peak: () => peak,
    started: () => [...started],
    /** Let task `id` finish, then yield so the pool can hand its slot on. */
    async finish(id: number, value = `done-${id}`) {
      gates[id](value)
      await tick()
    },
    async fail(id: number, reason = new Error(`task ${id} failed`)) {
      failures[id](reason)
      await tick()
    },
  }
}

/** Drain the microtask queue a few times over, so a chain of handovers settles. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('createTaskPool', () => {
  it('refuses a limit that could never drain', () => {
    // Clamping 0 to 1 would be the friendly thing and the wrong one: a pool
    // built with a limit nobody meant should say so at the call site, not
    // quietly behave like a different pool.
    expect(() => createTaskPool(0)).toThrow('at least 1')
    expect(() => createTaskPool(-3)).toThrow('at least 1')
    expect(() => createTaskPool(2.5)).toThrow('at least 1')
    expect(() => createTaskPool(Number.NaN)).toThrow('at least 1')
  })

  it('never runs more tasks at once than its limit', async () => {
    const t = tracker()
    const pool = createTaskPool(4)
    const runs = Array.from({ length: 20 }, (_, id) => pool.run(t.task(id)))
    await tick()

    expect(t.peak()).toBe(4)
    expect(t.started()).toEqual([0, 1, 2, 3])

    // And it is a limit, not a stall: finishing one admits exactly one more.
    await t.finish(0)
    expect(t.started()).toEqual([0, 1, 2, 3, 4])
    expect(t.peak()).toBe(4)

    for (let id = 1; id < 20; id += 1) await t.finish(id)
    await expect(Promise.all(runs)).resolves.toHaveLength(20)
    expect(t.peak()).toBe(4)
  })

  it('starts a full width of work immediately, rather than serialising it', async () => {
    // The operator adds a folder and expects rows to fill in. A pool that
    // admitted one task at a time would satisfy every bound in this file and
    // turn adding seventy clips into a queue seventy deep.
    const t = tracker()
    const pool = createTaskPool(4)
    void Array.from({ length: 20 }, (_, id) => pool.run(t.task(id)))
    await tick()
    expect(t.started()).toHaveLength(4)
  })

  it('drains every queued task and returns each result to its own caller', async () => {
    const t = tracker()
    const pool = createTaskPool(2)
    const runs = Array.from({ length: 7 }, (_, id) => pool.run(t.task(id)))
    await tick()
    for (let id = 0; id < 7; id += 1) await t.finish(id)

    await expect(Promise.all(runs)).resolves.toEqual([
      'done-0', 'done-1', 'done-2', 'done-3', 'done-4', 'done-5', 'done-6',
    ])
    expect(t.started()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(t.peak()).toBe(2)
  })

  it('does not wedge when a task rejects, and the rejection reaches its caller', async () => {
    // The case the defect this pool exists for was hiding behind: 65 of 71
    // thumbnail probes rejected, and `PlayScreen` swallowed every one. A pool
    // that leaked a slot per rejection would have stopped admitting work
    // entirely, and the symptom would have been identical.
    const t = tracker()
    const pool = createTaskPool(2)
    const runs = Array.from({ length: 6 }, (_, id) => pool.run(t.task(id)))
    runs.forEach((run) => { void run.catch(() => {}) })

    await tick()
    expect(t.started()).toEqual([0, 1])

    await t.fail(0)
    await t.fail(1)
    expect(t.started()).toEqual([0, 1, 2, 3])
    await expect(runs[0]).rejects.toThrow('task 0 failed')

    for (let id = 2; id < 6; id += 1) await t.finish(id)
    await expect(Promise.all(runs.slice(2))).resolves.toHaveLength(4)
    expect(t.peak()).toBe(2)
  })

  it('frees the slot of a task that throws before it ever returns a promise', async () => {
    const pool = createTaskPool(1)
    const thrower = pool.run(() => { throw new Error('synchronous') })
    await expect(thrower).rejects.toThrow('synchronous')

    // A synchronous throw skips every `await` inside the task, so a pool that
    // released only on the promise path would hold this slot for ever.
    await expect(pool.run(async () => 'after')).resolves.toBe('after')
  })

  it('holds the limit when every task in a batch rejects', async () => {
    const t = tracker()
    const pool = createTaskPool(3)
    const runs = Array.from({ length: 9 }, (_, id) => pool.run(t.task(id)))
    runs.forEach((run) => { void run.catch(() => {}) })
    await tick()
    for (let id = 0; id < 9; id += 1) await t.fail(id)

    await expect(Promise.allSettled(runs)).resolves.toHaveLength(9)
    expect(t.started()).toHaveLength(9)
    expect(t.peak()).toBe(3)
  })
})
