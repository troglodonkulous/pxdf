/**
 * PR 2's gate, on the wire, with the real app running.
 *
 * `engine.test.ts` grades the player's decisions and `sidecar.test.ts` grades
 * the supervisor, but neither of them starts Electron, starts Python, decodes a
 * video or puts a byte on a socket. PR 1's whole failure was a green test suite
 * over a half of the PR that had never been executed — so this script executes
 * it: it launches the built app, drives the real UI over the DevTools protocol,
 * and reads UDP off `127.0.0.1:60001` while it does.
 *
 * It is deliberately not a `vitest` test. It costs Electron, Python and ffmpeg,
 * it takes about half a minute, and a unit-test runner that sometimes needs
 * those is a unit-test runner people stop trusting. Run it by hand:
 *
 *     node test/e2e/wire.mjs
 *
 * ## What it can and cannot see
 *
 * It can see black. An all-zero framebuffer has exactly one wire encoding, so
 * "BLACKOUT is black", "idle is black" and "quitting leaves black behind" are
 * exact assertions here rather than inferences.
 *
 * It cannot see gaplessness, and does not claim to. `Sidecar` re-sends its last
 * frame forever when the renderer stalls, so a frozen cue change and a perfect
 * one are the same bytes. What this script asserts across a change is strictly
 * one-sided: **no black frame appears**. That catches a gap; it cannot prove the
 * absence of a stall, and `engine.test.ts` is what grades that.
 *
 * The clips are solid colours precisely so the one-sided check is sharp: every
 * packet of a non-black frame is then non-zero, and a single all-zero packet
 * body means a black frame rather than a dark corner of a real one.
 *
 * It can also see that the page threw, which it could not until 2026-08-12 and
 * which cost a session. Every check here reads a *wire* symptom, and a renderer
 * that raises the same exception every frame produces wire symptoms that look
 * like six unrelated failures. The last check is the only one that names a
 * cause; see `open` for why `Log.entryAdded` alone was not enough.
 *
 * ## Why the two clips are red and white rather than red and blue
 *
 * The cue-change check has to prove the change *happened* before "no black
 * appeared during it" means anything at all — otherwise a second cue that never
 * decodes leaves the first one on the wire for the whole window and the check
 * passes green having measured nothing. That was this file's first draft, and
 * it is the same laundering `CLAUDE.md` opens with.
 *
 * Telling the two apart has to survive the packet framing. A packet body is 507
 * or 453 bytes — neither divisible by 3 — so a body is not RGB-aligned and
 * per-channel sums are phase-shifted by the packet's offset into the
 * framebuffer. Red versus blue is therefore not decidable from one packet. Red
 * versus white is: a red framebuffer is `(255, 0, 0)` repeating, so about a
 * third of its bytes are non-zero, and a white one is all 255s. That ratio does
 * not care about phase.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** `mapper`'s packet header. Five bytes, not eight — see `docs/PROTOCOL.md`. */
const HEADER_LEN = 5
/** The shop rig's tile rows. Named because the hover check counts tiles, not columns. */
const SHOP_RIG_ROWS = 5
const PORT = 60_001
const DEBUG_PORT = 9_333
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const REPO_ROOT = resolve(APP_DIR, '..')
const PYTHON = process.env.DDF_PYTHON ?? 'python3'

/**
 * How long the wire may go quiet across a sidecar restart.
 *
 * Not a performance target — a safety margin. `docs/APP-PLAN.md` calls a 200 ms
 * restart fine; controller 1 reverts to the vendor's own content at about five
 * seconds. Two seconds sits well inside that and still fails loudly on the case
 * this bound exists for: a restart that hangs on a Python process which will
 * not exit, which on the floor is somebody else's content mid-show.
 */
const MAX_RESTART_GAP_MS = 2_000

const failures = []
let stepNumber = 0

function check(ok, description, detail = '') {
  stepNumber += 1
  const line = `${ok ? 'PASS' : 'FAIL'}  ${String(stepNumber).padStart(2, ' ')}. ${description}`
  console.log(detail === '' ? line : `${line}\n          ${detail}`)
  if (!ok) failures.push(description)
}

// --------------------------------------------------------------- test clips

function makeClip(directory, colour, seconds = 3) {
  const path = join(directory, `${colour}-${seconds}s.mp4`)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=640x480:r=30:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ])
  return path
}

/**
 * One clip, two colours back to back — for grading trim, which a single-colour
 * clip cannot: trimming red-then-red never shows whether the in-point moved.
 *
 * Red then *white*, not red then blue. `tone()` below tells red from white by
 * the fraction of a packet's body that is non-zero, which is phase-independent
 * — see its own comment. Red and blue would both be a third lit, from any
 * packet's phase, and indistinguishable from one another by that measure; this
 * file already rejected that pairing once, for the same reason, in the cue
 * pair right above.
 */
function makeSplitClip(directory, segments) {
  const path = join(directory, 'split.mp4')
  const inputs = segments.flatMap(([colour, seconds]) =>
    ['-f', 'lavfi', '-i', `color=c=${colour}:s=640x480:r=30:d=${seconds}`])
  const labels = segments.map((_, i) => `[${i}:v]`).join('')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', `${labels}concat=n=${segments.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ])
  return path
}

/**
 * A clip Chromium cannot open, in the form this repo actually ships.
 *
 * Rawvideo in AVI: `test-patterns/09-gradient24-8x8_4P-10x5.avi` is this, and
 * it is the file the cutover digest is graded on — so it is the first thing
 * anyone reaches for to try the player on, and the one the player cannot play.
 * Measured in `mediaFormats.ts`: `DEMUXER_ERROR_COULD_NOT_OPEN`.
 */
function makeUndecodableClip(directory) {
  const path = join(directory, 'rawvideo.avi')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30:d=2',
    '-c:v', 'rawvideo', '-pix_fmt', 'bgr24', path,
  ])
  return path
}

// ------------------------------------------------------------ wire capture

class WireTap {
  constructor() {
    this.packets = []
    /**
     * Arrival time of `packets[i]`, kept in a parallel array rather than by
     * boxing each packet.
     *
     * PR 3 restarts the sidecar whenever the floor's geometry changes, and a
     * restart is a real process swap: the old `mapper stream` has to stop being
     * the sender before the new one starts, or two processes interleave frames
     * onto one floor. So some interval with no datagrams is structural, and the
     * question a gate has to answer is *how long* — controller 1 reverts to the
     * vendor's own content about five seconds after packets stop. Without
     * timestamps that interval is unmeasurable and the gate can only assert it
     * by feel.
     *
     * Parallel array because `packets` is a flat list of raw buffers that every
     * predicate in this file already indexes into (`p.subarray`, `p[4]`).
     * Boxing them would touch each of those and grade nothing new.
     */
    this.times = []
    this.socket = createSocket('udp4')
    this.socket.on('message', (message) => {
      this.packets.push(message)
      this.times.push(Date.now())
    })
  }

  listen() {
    return new Promise((done) => this.socket.bind(PORT, '127.0.0.1', done))
  }

  /** Everything captured from now on, for `ms`. */
  async window(ms) {
    const from = this.packets.length
    await sleep(ms)
    return this.packets.slice(from)
  }

  /**
   * The longest silence between two consecutive packets, in milliseconds,
   * spanning from the last packet captured *before* `from` to the newest one.
   *
   * **The `- 1` is the whole measurement.** Callers take `from` as
   * `tap.packets.length` immediately before the action they are about to grade,
   * so if that action stops the wire at once — which is exactly what a sidecar
   * restart does — no packet arrives between `from` and the outage. Slicing at
   * `from` would start the window on the first packet after *recovery*, put the
   * entire blackout between `times[from - 1]` and `times[from]` where nothing
   * looks at it, and report the ~1.6 ms spacing of healthy traffic. A gate that
   * passes green through a thirty-second outage is worse than no gate: it is
   * the instrument-broken-reads-as-success failure this repo keeps a
   * postmortems file about. Anchoring one packet earlier makes the boundary
   * itself part of the measurement.
   *
   * `null` when fewer than two timestamps are in range — which is not "no gap",
   * it is *no measurement*, and the caller has to report it as such rather than
   * as a pass. A sidecar that never came back lands here.
   */
  maxGapMs(from) {
    const times = this.times.slice(Math.max(0, from - 1))
    if (times.length < 2) return null
    let worst = 0
    for (let i = 1; i < times.length; i++) worst = Math.max(worst, times[i] - times[i - 1])
    return worst
  }

  close() {
    this.socket.close()
  }
}

// Datagram header fields, as `mapper/frame.py:161` reads them back off the wire.
const isEndOfFrame = (packet) => (packet[4] & 0x80) !== 0

/**
 * Packets and bytes per frame, **measured** from a captured window.
 *
 * `mapper` sets the high bit of byte 4 on the last packet of each controller,
 * so one frame ends after every `controllerCount` flags. Counting between two
 * frame ends — rather than over the whole window — is what keeps a clipped
 * partial frame at either edge from reporting a packet count that is right
 * about nothing.
 *
 * Returns `null` when the window did not contain two complete frames. That is a
 * refusal, not a zero: a caller that treated it as a shape would be grading a
 * capture that never happened.
 */
function frameShape(packets, controllerCount) {
  if (packets.length === 0) return null

  // Every controller flags its own last packet, so a frame ends at the flag
  // belonging to the *highest-numbered* controller — the last one mapper sends
  // in a frame. Reading the controller off the datagram makes this
  // phase-independent, which "every controllerCount-th flag" was not: a capture
  // window opens wherever it opens, so that grouping was offset by however far
  // into a frame the window began and averaged across partial frames. It
  // reported 19.5 and 48.8 packets per frame — plausible enough to look like a
  // rounding quirk rather than a broken instrument.
  const controllers = new Set(packets.map((packet) => packet[1]))
  // A positive control on the window itself. Mid-restart it holds frames from
  // two geometries at once, and averaging across that boundary is meaningless.
  // Refuse rather than return a number nobody can interpret.
  if (controllers.size !== controllerCount) return null
  const lastController = Math.max(...controllers)

  const frameEnds = []
  for (let i = 0; i < packets.length; i++) {
    if (isEndOfFrame(packets[i]) && packets[i][1] === lastController) frameEnds.push(i)
  }
  if (frameEnds.length < 2) return null

  const body = packets.slice(frameEnds[0] + 1, frameEnds[frameEnds.length - 1] + 1)
  const frames = frameEnds.length - 1
  return {
    frames,
    packetsPerFrame: body.length / frames,
    bytesPerFrame: body.reduce((n, p) => n + p.length, 0) / frames,
  }
}

/**
 * What `mapper plan` says a geometry's frames look like.
 *
 * The oracle for every geometry assertion below. Shelling out per step costs
 * about 200 ms and buys the thing a hardcoded expectation cannot: if `mapper`'s
 * packetisation ever changes, this gate moves with it instead of grading the
 * app against a number nobody re-derived.
 */
function planShape(type, cols, rows) {
  const stdout = execFileSync(
    PYTHON,
    ['-m', 'mapper', 'plan', '--type', type, '--cols', String(cols), '--rows', String(rows)],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 24 },
  )
  const match = /(\d+) controller\(s\), (\d+) packets\/frame, (\d+) bytes\/frame/.exec(stdout)
  if (match === null) throw new Error(`could not read mapper plan output:\n${stdout}`)
  return {
    controllerCount: Number(match[1]),
    packetsPerFrame: Number(match[2]),
    bytesPerFrame: Number(match[3]),
  }
}

/** True when every byte of every packet body is zero. */
const allBlack = (packets) => packets.every((p) => p.subarray(HEADER_LEN).every((b) => b === 0))
/** True when at least one packet carries light. */
const anyLit = (packets) => packets.some((p) => p.subarray(HEADER_LEN).some((b) => b !== 0))

/**
 * Which clip a packet came from, decided by the fraction of its body that is
 * non-zero. Phase-independent, which per-channel sums are not — see the header.
 */
function tone(packet) {
  const body = packet.subarray(HEADER_LEN)
  let lit = 0
  for (const byte of body) if (byte !== 0) lit += 1

  const fraction = lit / body.length
  if (fraction === 0) return 'black'
  if (fraction > 0.9) return 'white'
  if (fraction > 0.2 && fraction < 0.5) return 'red'
  return 'other'
}

const countTone = (packets, want) => packets.filter((p) => tone(p) === want).length

// ------------------------------------------------------- DevTools protocol

async function attachToPage() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return await open(page.webSocketDebuggerUrl)
    } catch {
      // The port is not up yet.
    }
    await sleep(200)
  }
  throw new Error('Electron never exposed a debuggable page')
}

function open(url) {
  return new Promise((resolvePage, rejectPage) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    /**
     * Every uncaught exception the page raised, deduplicated by message.
     *
     * This listener is the instrument this file was missing, and its absence is
     * most of why the defect it was written against took a session to find. The
     * render loop reschedules its next frame on its first line — deliberately,
     * so a decoder failure cannot stop future writes — so an exception in the
     * middle of the loop body killed the wire write and every React update
     * behind it while the loop itself carried on. From outside there was no
     * error, no banner and no log entry: just a floor that stayed black and a
     * cue stack frozen mid-change. Sixty exceptions a second, none of them
     * visible to anything that was watching.
     *
     * `Log.entryAdded` is not enough on its own. The CORS refusal that caused it
     * did arrive as a log entry, but the `SecurityError` it led to arrives only
     * here, and it is the one that names the failing step.
     */
    const exceptions = new Map()
    let nextId = 0

    const send = (method, params) => {
      const id = (nextId += 1)
      return new Promise((settle) => {
        pending.set(id, settle)
        socket.send(JSON.stringify({ id, method, params }))
      })
    }

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        const text = String(details.exception?.description ?? details.text).split('\n')[0]
        const frame = details.stackTrace?.callFrames?.[0]
        exceptions.set(text, {
          text,
          count: (exceptions.get(text)?.count ?? 0) + 1,
          where: frame === undefined ? '' : `${frame.url}:${frame.lineNumber + 1}`,
        })
        return
      }
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      waiter(message)
    })
    socket.addEventListener('error', rejectPage)
    socket.addEventListener('open', async () => {
      await send('Runtime.enable', {})
      resolvePage({
        exceptions,
        /** Evaluate an expression in the page and return its JSON value. */
        async evaluate(expression) {
          const reply = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
          if (reply.result?.exceptionDetails !== undefined) {
            // `.text` alone is Chrome's generic marker — literally the string
            // "Uncaught" — for a thrown `Error`. The message is one level
            // deeper, in `.exception.description`, which is exactly what the
            // passive `Runtime.exceptionThrown` listener above already knows
            // to read. Without it this is the loud channel CLAUDE.md asks for
            // saying nothing louder than "something happened".
            const details = reply.result.exceptionDetails
            throw new Error(`page threw: ${details.exception?.description ?? details.text}`)
          }
          return reply.result?.result?.value
        },
        close: () => socket.close(),
      })
    })
  })
}

/** Click the first element matching a selector, failing loudly if it is missing. */
const clickScript = (selector) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)})
  if (element === null) throw new Error('no element for ${selector}')
  element.click()
  return true
})()`

/** Click the first button whose trimmed text starts with a string. */
const clickButtonScript = (text) => `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (button === undefined) throw new Error('no button labelled ${text}')
  button.click()
  return true
})()`

/** Select a cue by its row index, which in live mode arms it as Standby. */
const clickRowScript = (index) => `(() => {
  const rows = [...document.querySelectorAll('.cue-row')]
  if (rows[${index}] === undefined) throw new Error('no cue row ${index}')
  rows[${index}].click()
  return true
})()`

/**
 * Change a `<select>` the way the operator does.
 *
 * Same native-setter dance as the duration field above, and for the same
 * reason — React tracks the last value it set on the element instance, so a
 * direct `select.value = x` is recorded as "already seen" and the event that
 * follows is discarded as a no-op. The event is `change`: that is what React
 * maps `onChange` to for a select, where it uses `input` for a text field.
 */
const selectScript = (label, value) => `(() => {
  const select = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})
  if (select === null) throw new Error('no select labelled ${label}')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, ${JSON.stringify(String(value))})
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return select.value
})()`

/**
 * Hover a connector in the wiring diagram, and read back what lit up.
 *
 * Both event names are dispatched on purpose. React does not listen for
 * `mouseenter`/`mouseleave` at all — it delegates `mouseover`/`mouseout` at the
 * root container and synthesises `onMouseEnter`/`onMouseLeave` from them, so a
 * bare `mouseenter` reaches a native `addEventListener` and nothing else. Firing
 * both means this grades the highlight rather than the component's choice of
 * handler, and a red here is a real missing highlight instead of a test that
 * knew one framework detail and not the other.
 */
const hoverConnectorScript = (tileCol, leave = false) => `(() => {
  const connector = [...document.querySelectorAll('[data-connector-cols]')].find(
    (element) => element.dataset.connectorCols.split(' ').includes('${tileCol}'))
  if (connector === undefined) throw new Error('no connector for tile column ${tileCol}')
  for (const type of ${leave ? "['mouseout', 'mouseleave']" : "['mouseover', 'mouseenter']"}) {
    connector.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: null }))
  }
  return [...document.querySelectorAll('[data-tile-col].is-highlighted')]
    .map((element) => Number(element.dataset.tileCol))
})()`

// -------------------------------------------------------------------- main

/**
 * One wire gate at a time, machine-wide, held by the kernel.
 *
 * `PORT` and `DEBUG_PORT` are hardcoded, so two copies of this script — two
 * worktrees, two agents, a stray `npm run dev` — do not fail cleanly when they
 * overlap. Each run launches a sender that broadcasts to `PORT`, so a second
 * run's packets land in the first run's tap: fractional packet counts, which
 * read as a compositor bug rather than as two runs. A preflight `lsof` does not
 * fix it, because both runs can pass that check before either one binds. It has
 * to be taken here, before Electron and the sidecar start, because the harm is
 * done by the second run's *sender*, not by its tap.
 *
 * **A listening socket, not a lockfile.** Two earlier drafts of this used a
 * pidfile and both were raceable, in the same shape each time: a lock whose
 * existence *is* the lock can be deleted by somebody who read it a moment ago
 * and acted a moment late — either the script auto-clearing a dead owner while
 * another run was mid-acquire, or an operator running the `rm` that a stale-lock
 * message told them to run, after a newer run had already taken it. There is no
 * atomic compare-and-delete to close that with, and the versions that did close
 * it needed a second lock to guard the first.
 *
 * A listening socket has no such gap. `listen` is atomic, `EADDRINUSE` is
 * unambiguous, and **the kernel releases it when the process dies, however it
 * dies** — so there is no stale state to reclaim, nothing for a human to clear,
 * and no instruction that can be followed too late. `SIGKILL` mid-run leaves the
 * next run free to start immediately.
 *
 * TCP `PORT`, deliberately the same number as the UDP port being protected,
 * which nothing here listens on over TCP. `unref` stops it holding the event
 * loop open: its lifetime is then exactly the process's, which is the invariant
 * wanted, and it needs no release path to get it.
 */
const gateLock = createServer()

await new Promise((acquired) => {
  gateLock.once('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error
    console.error(`\nanother wire gate is already running on this machine (TCP ${PORT}).`)
    console.error('Only one may run: UDP 60001 and the DevTools port are hardcoded, and a')
    console.error("second run's sender lands in the first run's tap rather than failing.")
    console.error('Wait for it to finish, or stop it, and re-run.')
    process.exit(2)
  })
  gateLock.listen(PORT, '127.0.0.1', () => {
    gateLock.unref()
    acquired()
  })
})

const workspace = mkdtempSync(join(tmpdir(), 'ddf-e2e-'))
const tap = new WireTap()
let electron = null
let page = null

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) {
    throw new Error('dist/main.js is missing — run `npm run build` first')
  }

  // Refuse to run against somebody else's app. A previous run that threw used
  // to leave a real Electron behind holding this port (see the teardown), and
  // attaching to it grades a stale build with a stale `allowedMedia` — every
  // file 403s, and a 403 body reaches the demuxer as the same error an
  // unsupported container gives. That is exactly how `probe-containers.mjs`
  // produced a uniformly false table that looked entirely plausible.
  const squatter = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    .then(() => true, () => false)
  if (squatter) {
    throw new Error(
      `something is already listening on ${DEBUG_PORT}. A previous run leaked an ` +
      'Electron process; kill it before trusting anything this script prints.',
    )
  }

  const clips = [makeClip(workspace, 'red'), makeClip(workspace, 'white')]
  // A container this build cannot demux, measured in `mediaFormats.ts`: rawvideo
  // in AVI, which is what every test pattern in this repo actually is. Seeded
  // through the picker like the others, because `DDF_PICK_MEDIA` bypasses the
  // dialog's extension filter — the filter is a courtesy, and the failed-cue
  // path is the thing that has to hold when something gets past it.
  //
  // If this check ever goes red saying the wire lit up, the likely cause is an
  // Electron upgrade that decodes AVI. That is a change to `mediaFormats.ts`'s
  // measured table, not a bug in the player.
  const undecodable = makeUndecodableClip(workspace)
  // Never seeded into the picker, and therefore never in `main.ts`'s
  // `allowedMedia`. Identical in every other respect to the two above, which is
  // the point: the only thing that decides whether it is served is whether a
  // human chose it.
  const unpicked = makeClip(workspace, 'green')

  // PR 3's engine half: loop and trim, seeded onto two more cues with no
  // editing UI at all — that UI lands with the merge from `app-player-layout`
  // (`docs/APP-PLAN.md`, "the inspector and trim-mode UI wait"). `DDF_CUE_SEED`
  // is a test-only, env-var-gated seam of exactly the shape `DDF_PICK_MEDIA`
  // already is: a JSON object keyed by picked path, read once in `main.ts` and
  // applied to a cue's `loop`/`trimStartMs`/`trimEndMs` at add time in
  // `PlayScreen.tsx`'s `addMedia` — nothing a real launch ever sets.
  //
  // `loopClip` is a plain 1 s clip; `loop: 2` gives it a 1,000 ms x 2 = 2,000 ms
  // hold. `trimClip` is red for 1.2 s then white — trimmed to start at 1,200 ms,
  // its first frame on the wire has to be white, never the red in-point.
  const loopClip = makeClip(workspace, 'white', 1)
  const trimClip = makeSplitClip(workspace, [['red', 1.2], ['white', 1.8]])
  const cueSeed = {
    [loopClip]: { loop: 2, trimStartMs: 0, trimEndMs: null },
    [trimClip]: { loop: null, trimStartMs: 1_200, trimEndMs: null },
  }

  await tap.listen()

  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DDF_ADDRESS: '127.0.0.1',
        DDF_PORT: String(PORT),
        DDF_PICK_MEDIA: [...clips, undecodable, loopClip, trimClip].join(delimiter),
        DDF_CUE_SEED: JSON.stringify(cueSeed),
      },
      stdio: 'inherit',
      // `node_modules/.bin/electron` is a Node shim that spawns the real binary
      // as a child. It forwards SIGINT and SIGTERM — which is why the graceful
      // quit below works — but SIGKILL cannot be caught, so killing the shim
      // leaves the real Electron running, holding this debug port and the UDP
      // socket. Its own process group makes the teardown able to take both.
      detached: true,
    },
  )

  page = await attachToPage()

  /**
   * Poll a page expression until it returns something truthy.
   *
   * Every DOM read in this file has to poll. React republishes engine state on
   * a sampling tick of at least 250 ms, so a single read taken right after an
   * action reads the state before it — see `waitForLive` below, where assuming
   * instead of polling failed roughly one run in two against a healthy app.
   */
  const waitFor = async (expression, attempts = 25) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await page.evaluate(expression)
      if (value) return value
      await sleep(200)
    }
    return null
  }

  // 1. The sidecar is up and sending before anything has been asked of it.
  const idle = await tap.window(1_000)
  check(idle.length > 0, 'the sidecar sends while the player is idle',
    `${idle.length} packets in 1 s (expect ~600/s at 30 fps x 20 packets)`)
  // The count is re-asserted here rather than borrowed from the check above.
  // `allBlack([])` is true, so on a run where nothing was captured this line
  // would report a cheerful PASS next to the FAIL that explains it — and a
  // green line is what gets read. Every other black check in this file guards
  // the same way; this was the one that did not.
  check(idle.length > 0 && allBlack(idle), 'idle is black frames, not silence',
    `${idle.length} packets`)

  // 1a. And it is sending from the *Mapping* surface, with no project loaded.
  //
  //     This says where the app was standing while the two checks above passed.
  //     It is deliberately not claimed as the gate on the render loop, because
  //     it measurably is not one. Unmounting the preview canvas while Mapping
  //     is showing — the exact defect the restructure exists to prevent, since
  //     the loop returns before `writeFrame` when that ref is null — leaves
  //     checks 1, 2 and this one all green: `mapper stream` re-sends its last
  //     frame forever when the renderer stalls, so a dead loop still puts 600
  //     black packets a second on the wire at exactly the right size.
  //
  //     What catches it is every check downstream that needs real content. The
  //     loop's effect is keyed on `[engine]`, so it never re-arms when the
  //     canvas mounts later, and nothing the engine produces ever reaches the
  //     wire. Measured: that mutation fails 14 of these checks, the first at
  //     step 13. Recorded here because "black on the wire" reading as "the
  //     renderer is alive" is precisely the inference this file exists to
  //     refuse.
  const onMapping = await waitFor('document.querySelector(".mapping-screen") !== null ? 1 : 0')
  check(onMapping === 1, 'the app launches on the Mapping surface')
  check(await page.evaluate('document.querySelector(".play-screen") === null'),
    'Play is not mounted until it is opened')

  // And the sender indicator agrees with the wire it is describing.
  //
  // It did not. `Sidecar` publishes its live status when the child spawns and
  // `main.ts` re-publishes on `did-finish-load`, and both land before React's
  // effect has subscribed — so nothing re-published until the *next* spawn and
  // the pill sat on its initial 'Restarting' while 600 packets a second were
  // leaving the socket. Cosmetic only until you remember what the indicator is
  // for: an operator who has seen it cry wolf once reads straight past it on
  // the night it is right. Asserted against the same window that just proved
  // packets are flowing, because that pairing is the whole claim.
  //
  // Note what this does *not* assert, and cannot: that the floor is receiving.
  // The pill used to read "Linked" and this check used to grade that word. It
  // was never earned — `mapper` broadcasts UDP and never reads a reply, so no
  // instrument in this repo can tell a live floor from an unplugged one.
  const linkLabel = await waitFor(
    'document.querySelector(".status-pill")?.textContent?.trim() === "Sending" ? "Sending" : null')
  check(linkLabel === 'Sending', 'the sender indicator says Sending while the wire is live',
    String(await page.evaluate('document.querySelector(".status-pill")?.textContent?.trim() ?? null')))

  const shop = planShape('8x8_4P', 10, SHOP_RIG_ROWS)
  const idleShape = frameShape(idle, shop.controllerCount)
  check(idleShape !== null
    && idleShape.packetsPerFrame === shop.packetsPerFrame
    && idleShape.bytesPerFrame === shop.bytesPerFrame,
    'Mapping idles at the shop rig frame shape mapper plan describes',
    idleShape === null
      ? 'no complete frame captured'
      : `${idleShape.packetsPerFrame} packets / ${idleShape.bytesPerFrame} bytes per frame, ` +
        `want ${shop.packetsPerFrame} / ${shop.bytesPerFrame}`)

  // 1b. The NIC picker is populated from the host, not from a placeholder.
  //
  //     Only half of this is gradeable off-hardware, and the half that is not
  //     is stated rather than quietly skipped: that choosing an interface
  //     actually changes which NIC datagrams egress from needs a machine with
  //     more than one, and nothing below claims it.
  const nicCount = await waitFor(
    'document.querySelectorAll(\'[aria-label="Network interface"] option\').length')
  check(typeof nicCount === 'number' && nicCount > 0,
    'the Network panel lists at least one interface', `${nicCount} options`)

  // 1c. Rotation is presentation, not orientation — it must not restart anything.
  //
  //     `mapper/` receives the same row-major framebuffer at every rotation, so
  //     a Rotation change has no business reaching the sidecar. If it ever
  //     starts calling `setFloor`, the frame shape stays identical but the wire
  //     goes quiet for a spawn — so the gap is what catches it, not the shape.
  //     It must, however, do something the operator can see. Rotation shipped
  //     changing nothing on this surface at all: the diagram's `viewBox` came
  //     back byte-identical and only `aria-pressed` moved. A control that is
  //     graded solely on what it must *not* disturb passes just as green when
  //     it does nothing whatsoever, so the visible half is asserted too — the
  //     canvas turns, which at 90° means the viewBox swaps its axes.
  const uprightViewBox = await page.evaluate(
    'document.querySelector(".mapping-diagram")?.getAttribute("viewBox") ?? null')
  const beforeRotation = tap.packets.length
  await page.evaluate(clickScript('[aria-label="Rotation 90 degrees"]'))
  const turnedViewBox = await waitFor(`(() => {
    const box = document.querySelector('.mapping-diagram')?.getAttribute('viewBox') ?? null
    return box !== null && box !== ${JSON.stringify(uprightViewBox)} ? box : null
  })()`)
  check(typeof uprightViewBox === 'string' && typeof turnedViewBox === 'string'
      && turnedViewBox.split(' ').slice(2).reverse().join(' ') === uprightViewBox.split(' ').slice(2).join(' '),
    'Rotation turns the diagram', `${uprightViewBox} -> ${turnedViewBox}`)
  await sleep(800)
  const rotated = tap.packets.slice(beforeRotation)
  const rotatedShape = frameShape(rotated, shop.controllerCount)
  const rotationGap = tap.maxGapMs(beforeRotation)
  check(rotatedShape !== null && rotatedShape.bytesPerFrame === shop.bytesPerFrame,
    'Rotation leaves the frame size alone',
    rotatedShape === null ? 'no complete frame captured' : `${rotatedShape.bytesPerFrame} bytes`)
  check(rotationGap !== null && rotationGap < 200,
    'Rotation does not restart the sidecar',
    rotationGap === null ? 'no measurement' : `largest silence ${rotationGap} ms`)
  await page.evaluate(clickScript('[aria-label="Rotation 0 degrees"]'))

  // 1d. Hovering a connector lights the tile columns it feeds.
  //
  //     Narrow on purpose. This is not a visual gate — it asserts the state the
  //     highlight is driven from, and that it is released again, which is the
  //     half that silently rots.
  //     Dispatch, then *poll* for the result. The highlight is React state, so
  //     the re-render lands after the event handler returns — a read taken
  //     synchronously after `dispatchEvent` sees the DOM as it was before the
  //     hover and grades a working component red. This file argues for polling
  //     twice in its own comments and `APP-PLAN.md` states it as a rule; the
  //     first version of this check did a bare read anyway.
  await page.evaluate(hoverConnectorScript(3))
  const hovered = await waitFor(`(() => {
    const lit = [...document.querySelectorAll('[data-tile-col].is-highlighted')]
      .map((element) => Number(element.dataset.tileCol))
    return lit.length > 0 ? lit : null
  })()`)
  //     Exactly columns 2 and 3, not merely "includes 3". One cable carries two
  //     ports to two adjacent columns, so a jack that lit only the column it was
  //     asked about would be the port model surviving inside the jack one, and
  //     `includes` would pass it green.
  //
  //     Both the columns and the tile count, because `hovered` is one entry per
  //     *tile*: two columns of a five-row floor is ten of them. Asserting the
  //     distinct columns alone would pass a highlight that lit only the top row,
  //     and asserting the count alone would pass one that lit the wrong pair.
  const litColumns = Array.isArray(hovered) ? [...new Set(hovered)].sort((a, b) => a - b) : null
  check(litColumns !== null && litColumns.length === 2
      && litColumns[0] === 2 && litColumns[1] === 3
      && hovered.length === 2 * SHOP_RIG_ROWS,
    'hovering a connector highlights both tile columns it feeds',
    `columns ${JSON.stringify(litColumns)} over ${hovered?.length ?? 0} tiles`)

  await page.evaluate(hoverConnectorScript(3, true))
  const highlightCleared = await waitFor(
    'document.querySelectorAll(\'[data-tile-col].is-highlighted\').length === 0 ? "cleared" : null')
  check(highlightCleared === 'cleared', 'the highlight is released on hover-out',
    `${await page.evaluate('document.querySelectorAll(\'[data-tile-col].is-highlighted\').length')} still lit`)

  // 1e. Into Play, which is where the rest of this file has always run.
  await page.evaluate(clickButtonScript('Open Player'))
  const onPlay = await waitFor('document.querySelector(".play-screen") !== null ? 1 : 0')
  check(onPlay === 1, 'Open Player reaches the Play surface')

  // 2. A cue reaches the wire. This is also the only place the readiness path
  //    is exercised for real: the video elements are detached from the
  //    document, and if `ready` never flipped, GO would silently do nothing.
  await page.evaluate(clickScript('[aria-label="Add cue"]'))
  // Polled, not slept. The picker is an IPC round trip and the rows are a React
  // render behind it, and a fixed wait that is long enough on a warm machine
  // reads zero cues on a cold one — grading a healthy app red. This file argues
  // for polling twice in its own comments and then did this.
  //
  // Five, not three: `red`, `white`, `undecodable`, then `loopClip` and
  // `trimClip` — rows 3 and 4, exercised in step 6 below. Appended, so every
  // row index the rest of this file already assumes (0, 1, 2) still holds.
  const cueCount = await waitFor(
    'document.querySelectorAll(".cue-row").length === 5 ? 5 : 0')
  check(cueCount === 5, 'all five seeded cues land in the stack',
    `saw ${await page.evaluate('document.querySelectorAll(".cue-row").length')}`)

  // 2a. A cue that cannot decode, fired from idle.
  //
  //     From idle specifically. `engine.test.ts` already grades the case where
  //     a cue fails while another is live, and there the correct behaviour is
  //     to hold the live content — so running this second would assert nothing
  //     about black. With nothing live, the floor has to stay black and the
  //     operator has to be told, and those are two separate failures: a banner
  //     with light on the wire is a lie, and black with no banner is the
  //     silent-failure mode this whole file exists to catch.
  await page.evaluate(clickRowScript(2))
  const beforeBadGo = tap.packets.length
  await page.evaluate(clickButtonScript('GO'))
  const bannerText = await waitFor(
    'document.querySelector(".error-banner")?.textContent ?? null')
  check(typeof bannerText === 'string' && bannerText.includes('rawvideo'),
    'an undecodable cue names itself in the banner', String(bannerText))

  const afterBadGo = tap.packets.slice(beforeBadGo)
  // Both halves asserted. `allBlack([])` is vacuously true, so a run that
  // captured nothing at all would otherwise pass this as "black".
  check(afterBadGo.length > 0 && allBlack(afterBadGo),
    'the wire stays black when the fired cue cannot decode',
    `${afterBadGo.length} packets, ${countTone(afterBadGo, 'black')} of them black`)

  // Back to cue 1 for the rest of the run. This also arms the check below: the
  // banner is up right now, and `no cue reported a failure` only means
  // something because of it — a successful promotion is what clears it.
  //
  // Read here rather than relied on from thirty lines up. A check whose meaning
  // comes from a *different* check passing is the `allBlack([])` shape again: an
  // app that rendered no banner at all would fail that one and sail through this
  // one, which would then be reporting a clear that never happened.
  const bannerBeforeGo = await page.evaluate(
    'document.querySelector(".error-banner")?.textContent ?? null')
  await page.evaluate(clickRowScript(0))
  await page.evaluate(clickButtonScript('GO'))
  let lit = []
  for (let attempt = 0; attempt < 25 && !anyLit(lit); attempt++) lit = await tap.window(200)
  check(anyLit(lit), 'GO puts a decoded frame on the wire')
  check(countTone(lit, 'red') > 0, 'the frame on the wire is the first cue',
    `red ${countTone(lit, 'red')} · white ${countTone(lit, 'white')} · black ${countTone(lit, 'black')}`)

  // The banner is the operator's only view of a cue that could not play, and it
  // is the check that survives the render loop learning to swallow a per-frame
  // throw. Before that fix a tainted work canvas showed up here as an uncaught
  // `SecurityError`; after it, the loop catches it, marks the source failed and
  // the engine names the cue — correct behaviour, and completely silent to a
  // check that only watches for exceptions. So both are graded, and this is the
  // one that would still be red if the media stopped being CORS-clean.
  //
  // It is also the check that the banner *clears*. It was up a moment ago, put
  // there by the undecodable cue above, and the only thing that takes it down
  // is a cue actually reaching the wire. Pressing GO does not, and used to.
  //
  // Polled, and it has to be. Making this check mean something is what exposed
  // that: while no failure had ever been raised, a single read saw `null`
  // whatever the timing, and the check passed without waiting for anything. Now
  // that a banner is genuinely up when this runs, clearing it has to travel
  // through the same >=250 ms sampling tick as every other piece of engine
  // state, and an unpolled read here reports a healthy app red.
  const cleared = await waitFor(
    'document.querySelector(".error-banner") === null ? "cleared" : ""')
  check(typeof bannerBeforeGo === 'string' && cleared === 'cleared',
    'a successful cue clears the previous failure',
    `before ${JSON.stringify(bannerBeforeGo)} · after ${JSON.stringify(
      await page.evaluate('document.querySelector(".error-banner")?.textContent ?? null'))}`)

  // 2b. The media handler serves opened files and nothing else. Registering a
  //     custom scheme hands the renderer a function it can call with a path of
  //     its choosing, so `main.ts` keeps the paths the picker returned and
  //     refuses everything else. `unpicked` is the same kind of file, made the
  //     same way, differing only in never having been chosen — so a pass here
  //     cannot be explained by the clip being unplayable.
  const unpickedUrl = `ddf-media://file${unpicked.split('/').map(encodeURIComponent).join('/')}`
  const refused = await page.evaluate(`
    new Promise((done) => {
      const v = document.createElement('video')
      v.muted = true
      v.crossOrigin = 'anonymous'
      v.addEventListener('error', () => done('refused'))
      v.addEventListener('loadeddata', () => done('SERVED'))
      // A distinct outcome, not a third vote for 'refused'. Counting the
      // timeout as a refusal made this check pass for a handler that never
      // answered at all — a hung protocol handler and a correct 403 were the
      // same green line, and "not served" is a claim about a decision rather
      // than about waiting long enough.
      setTimeout(() => done('TIMEOUT'), 4000)
      v.src = ${JSON.stringify(unpickedUrl)}
      v.load()
    })
  `)
  check(refused === 'refused', 'a file the operator never opened is refused, not merely slow',
    `handler returned ${refused}`)

  // 3. A cue change. The first two checks establish that the change actually
  //    happened — without them, a second cue that never decodes leaves the
  //    first on the wire and "no black appeared" grades nothing at all. Only
  //    then does the third check mean something, and even then it is strictly
  //    one-sided: it catches a gap, and cannot prove the absence of a stall,
  //    because `Sidecar` re-sends. `engine.test.ts` owns that half.
  const liveIndex = '[...document.querySelectorAll(".cue-row")]' +
    '.findIndex((row) => row.classList.contains("is-live"))'

  /**
   * Wait for the cue stack to show a row as live, or give up after 5 s.
   *
   * The wait is not politeness, and the check below used to do without it. The
   * `is-live` class is React's *mirror* of engine state, and the render loop
   * republishes that mirror on a sampling tick of at least 250 ms — so the wire
   * carries a cue for up to a quarter of a second before the class appears. The
   * lit-packet check above exits the instant the first lit packet lands, which
   * drops the next line inside that window often enough to fail roughly one run
   * in two on this machine: a healthy app graded red by an instrument reading a
   * stale copy of the thing it was asking about.
   *
   * That is the same shape of error as everything in `CLAUDE.md`'s opening
   * paragraph, pointed the other way round, and it is worth naming: an
   * intermittent red here means "ask again", never "the app is broken". Both
   * live-cue checks now poll; neither may assume.
   */
  const waitForLive = async (want) => {
    let index = -1
    for (let attempt = 0; attempt < 25 && index !== want; attempt++) {
      index = await page.evaluate(liveIndex)
      if (index !== want) await sleep(200)
    }
    return index
  }

  const liveBefore = await waitForLive(0)
  check(liveBefore === 0, 'cue 1 is the live cue before the change',
    `live row index ${liveBefore}`)

  const fromChange = tap.packets.length
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)

  const movedTo = await waitForLive(1)
  check(movedTo === 1, 'the second cue actually became live', `live row index ${movedTo}`)

  const across = tap.packets.slice(fromChange)
  check(countTone(across, 'red') > 0 && countTone(across, 'white') > 0,
    'both cues are visible on the wire across the change',
    `red ${countTone(across, 'red')} · white ${countTone(across, 'white')}`)
  check(countTone(across, 'black') === 0, 'no black frame appears across the cue change',
    `${countTone(across, 'black')} of ${across.length} packets were all-zero`)

  // 3b. Loop and trim reach the wire — PR 3's engine half, proven with no
  //     editing UI at all. `loopClip` and `trimClip` (rows 3 and 4) already
  //     carry `loop`/`trimStartMs` from `DDF_CUE_SEED`, applied at add time in
  //     `addMedia` — the same path a real cue goes through once the Loop/Trim
  //     controls exist. This only replaces the operator's not-yet-built click;
  //     nothing about the engine or the decoder downstream of it is a stub.
  //
  //     First, that the add-time probe actually landed. `mediaDurationMs` is
  //     probed asynchronously (`probeDurationMs`), and firing `loopClip` before
  //     it resolves would leave the hold unknown — which the engine correctly
  //     reads as "never advance", per `engine.test.ts`'s failed-probe case, so
  //     a race here would read as a hang rather than as what it is. Polled,
  //     not assumed, for exactly that reason.
  await page.evaluate(clickRowScript(3))
  const probed = await waitFor(
    'document.querySelector(".cue-duration-readout")?.textContent !== "—" ? "probed" : ""')
  check(probed === 'probed', 'the add-time duration probe reaches the inspector',
    String(await page.evaluate('document.querySelector(".cue-duration-readout")?.textContent ?? null')))

  const beforeLoop = tap.packets.length
  const loopStartedAt = Date.now()
  await page.evaluate(clickButtonScript('GO'))
  const loopLive = await waitForLive(3)
  check(loopLive === 3, 'the loop cue goes live', `live row index ${loopLive}`)

  // loop: 2 on a 1 s clip holds for 1,000 x 2 = 2,000 ms, then advances with no
  // GO and no black in between. `MAX_RESTART_GAP_MS` is reused as the budget
  // for the next cue's decode, stacked on top of the hold itself — the same
  // number this file already uses for "does not strand the floor".
  const advancedTo = await waitForLive(4)
  const loopElapsed = Date.now() - loopStartedAt
  check(advancedTo === 4, 'loop: 2 on a 1 s clip advances to the next cue with no GO',
    `live row index ${advancedTo} after ${loopElapsed} ms`)
  check(loopElapsed >= 1_900, 'the loop held its full 2 s rather than firing early',
    `advanced after ${loopElapsed} ms`)
  check(loopElapsed <= 2_000 + MAX_RESTART_GAP_MS, 'the advance landed inside the restart budget',
    `advanced after ${loopElapsed} ms, budget ${2_000 + MAX_RESTART_GAP_MS} ms`)

  const acrossLoop = tap.packets.slice(beforeLoop)
  check(acrossLoop.length > 0 && countTone(acrossLoop, 'black') === 0,
    'no black packets appear across the loop-driven advance',
    `${countTone(acrossLoop, 'black')} of ${acrossLoop.length} packets were all-zero`)

  // And the cue it landed on is the trimmed one. Its very first content on the
  // wire is already past the red in-point — `VideoSource` seeks to
  // `trimStartMs` before the first frame is ever composed, rather than
  // starting at 0 and skipping forward after the fact, which would show red
  // for at least one frame.
  const trimmedOnset = tap.packets.slice(-40)
  check(countTone(trimmedOnset, 'red') === 0,
    'the trimmed cue never shows its red in-point on the wire',
    `red ${countTone(trimmedOnset, 'red')} of ${trimmedOnset.length} recent packets`)
  check(countTone(trimmedOnset, 'white') > 0,
    'the trimmed cue starts already past the in-point',
    `white ${countTone(trimmedOnset, 'white')} of ${trimmedOnset.length} recent packets`)

  // 4. BLACKOUT is black on the wire, and is not a teardown.
  await page.evaluate(clickButtonScript('BLACKOUT'))
  await sleep(500)
  const blacked = await tap.window(700)
  check(blacked.length > 0 && allBlack(blacked), 'BLACKOUT sends black frames and keeps sending',
    `${blacked.length} packets, all zero`)

  await page.evaluate(clickButtonScript('BLACKOUT'))
  await sleep(400)
  const restored = await tap.window(700)
  check(anyLit(restored), 'releasing BLACKOUT restores the running cue without a reload')

  // 4a. Back to Mapping, with a cue still running. Navigation must not gap the
  //     wire: the render loop and the canvas it writes through live at the root
  //     and are never unmounted, so there is nothing here that should even
  //     briefly stop the send. Asserted rather than trusted by construction.
  //
  //     The window is held open deliberately. `maxGapMs` needs two packets to
  //     measure anything, and the surface switch can complete inside a single
  //     CDP round trip — so measuring only for as long as the switch took
  //     reported "no measurement" on the fast runs, which is indistinguishable
  //     from the wire having died. Both readings failed, so nothing was
  //     laundered green, but a check that flaps is a check people learn to
  //     re-run. Half a second at 600 packets/s is ~300 packets: null now means
  //     silence, and silence is the thing being tested for.
  const beforeNav = tap.packets.length
  await page.evaluate(clickButtonScript('Mapping'))
  const backOnMapping = await waitFor('document.querySelector(".mapping-screen") !== null ? 1 : 0')
  check(backOnMapping === 1, 'the Mapping button returns to the Mapping surface')
  await sleep(500)
  const navGap = tap.maxGapMs(beforeNav)
  check(navGap !== null && navGap < 200, 'navigating between surfaces does not gap the wire',
    navGap === null ? 'no measurement' : `largest silence ${navGap} ms`)

  // 4b. Geometry becomes a runtime variable — the load-bearing half of PR 3.
  //
  //     Every step is graded against `mapper plan`'s own numbers for that
  //     geometry rather than against a constant written here, so this gate
  //     moves with `mapper` instead of drifting from it. Both Width and Height
  //     are driven, not just Height: the app's default width is already 10, so
  //     a gate that only ever changed Height would pass with the Width handler
  //     wired to nothing at all.
  const geometrySteps = [
    // Type first, and specifically the one that was missing from `TILE_PX`.
    // Selecting it used to throw *after* the running sidecar had been stopped,
    // which left the floor with no sender and every later change a silent
    // no-op. If that regresses, the frame shape below never arrives.
    { label: 'Floor type', value: '6x6_8P', type: '6x6_8P', cols: 10, rows: 5 },
    { label: 'Floor type', value: '8x8_4P', type: '8x8_4P', cols: 10, rows: 5 },
    { label: 'Floor width in tiles', value: '12', type: '8x8_4P', cols: 12, rows: 5 },
    { label: 'Floor width in tiles', value: '10', type: '8x8_4P', cols: 10, rows: 5 },
    { label: 'Floor height in tiles', value: '12', type: '8x8_4P', cols: 10, rows: 12 },
  ]

  for (const step of geometrySteps) {
    const want = planShape(step.type, step.cols, step.rows)
    const from = tap.packets.length
    await page.evaluate(selectScript(step.label, step.value))

    // A *fresh* window each attempt, not a growing slice from `from`. The slice
    // always contains the transition itself — old-geometry frames, the restart,
    // then new ones — and averaging across that boundary describes neither
    // geometry. Once the new sidecar settles, a short window holds only its
    // frames. Polled rather than slept because a restart is a Python spawn and
    // a wait long enough on a warm machine reads the old geometry on a cold one.
    let got = null
    for (let attempt = 0; attempt < 25; attempt++) {
      got = frameShape(await tap.window(400), want.controllerCount)
      if (got !== null && got.bytesPerFrame === want.bytesPerFrame) break
    }

    check(got !== null
      && got.packetsPerFrame === want.packetsPerFrame
      && got.bytesPerFrame === want.bytesPerFrame,
      `${step.type} ${step.cols}x${step.rows} reaches the wire as mapper plan describes`,
      got === null
        ? 'no complete frame captured after the change'
        : `${got.packetsPerFrame} packets / ${got.bytesPerFrame} bytes per frame, ` +
          `want ${want.packetsPerFrame} / ${want.bytesPerFrame}`)

    // The transport gap. A restart is a real process swap, so some silence is
    // structural — the gate is that it stays far short of the ~5 s at which
    // controller 1 gives up and shows the vendor's own content.
    const gap = tap.maxGapMs(from)
    check(gap !== null && gap < MAX_RESTART_GAP_MS,
      `the restart to ${step.type} ${step.cols}x${step.rows} does not strand the floor`,
      gap === null ? 'no measurement' : `largest silence ${gap} ms, budget ${MAX_RESTART_GAP_MS} ms`)
  }

  // 4c. The renderer adopted the new geometry — not just the sidecar's argv.
  //
  //     This is the check that separates "main.ts respawned Python with new
  //     --cols/--rows" from "the decode -> compose -> wire path ran at 80 x 96".
  //     An all-black assertion cannot: `mapper stream` emits black at startup
  //     and `Sidecar` writes a black frame on spawn, so black at the right size
  //     is exactly what a renderer stuck at the old geometry — or not running
  //     at all — also produces. Real content at the new byte length cannot come
  //     from anywhere but the real path.
  const job = planShape('8x8_4P', 10, 12)
  const atJobRig = await tap.window(1_000)
  const jobShape = frameShape(atJobRig, job.controllerCount)
  check(atJobRig.length > 0 && anyLit(atJobRig),
    'the running cue is still on the wire after the geometry change',
    `${atJobRig.length} packets, ${countTone(atJobRig, 'black')} of them all-zero`)
  check(jobShape !== null && jobShape.bytesPerFrame === job.bytesPerFrame,
    'that content is composed at the job rig, 50 packets and 23,290 bytes per frame',
    jobShape === null ? 'no complete frame captured' : `${jobShape.bytesPerFrame} bytes per frame`)

  // 4d. A type change that would make the current height illegal clamps it,
  //     says so, and keeps sending.
  //
  //     The floor is 10 x 12 here, which `mapper` allows on 8x8_4P (max 22
  //     rows) and refuses on 8x8_8P (max 11). Before the limits were per type,
  //     picking 8x8_8P here stopped the running sidecar, spawned a `mapper
  //     stream` that exited on startup with `tile_rows 12 outside 1..11`, and
  //     left the floor with no sender at all — controller 1 reverting to the
  //     vendor's own content five seconds later, mid-show. It was reachable
  //     from a dropdown.
  //
  //     Graded on the consequence, not the symptom: the wire keeps carrying
  //     frames, at the shape `mapper plan` gives for the clamped geometry.
  const clamped = planShape('8x8_8P', 10, 11)
  const beforeClamp = tap.packets.length
  await page.evaluate(selectScript('Floor type', '8x8_8P'))

  let clampedShape = null
  for (let attempt = 0; attempt < 25; attempt++) {
    clampedShape = frameShape(await tap.window(400), clamped.controllerCount)
    if (clampedShape !== null && clampedShape.bytesPerFrame === clamped.bytesPerFrame) break
  }
  check(clampedShape !== null && clampedShape.bytesPerFrame === clamped.bytesPerFrame,
    'a type whose row limit is lower clamps the height instead of stranding the floor',
    clampedShape === null
      ? 'no complete frame captured — the sender may be gone'
      : `${clampedShape.packetsPerFrame} packets / ${clampedShape.bytesPerFrame} bytes per frame, ` +
        `want ${clamped.packetsPerFrame} / ${clamped.bytesPerFrame}`)

  const clampGap = tap.maxGapMs(beforeClamp)
  check(clampGap !== null && clampGap < MAX_RESTART_GAP_MS,
    'the clamped restart does not strand the floor either',
    clampGap === null ? 'no measurement' : `largest silence ${clampGap} ms`)

  // And the operator is told. Quietly shrinking a floor by a row is a silent
  // success, which is the thing this repo refuses on principle.
  const clampNotice = await waitFor(
    'document.querySelector(".notice-banner")?.textContent ?? null')
  check(typeof clampNotice === 'string' && clampNotice.includes('11'),
    'the operator is told the height was reduced', String(clampNotice))

  // 5. Quitting leaves the floor black. Controllers 2 and 3 hold their last
  //    frame indefinitely, so the last frame sent is the one that stays lit.
  const beforeQuit = tap.packets.length
  electron.kill('SIGTERM')
  await sleep(2_500)
  const tail = tap.packets.slice(beforeQuit).slice(-20)
  check(tail.length > 0 && allBlack(tail), 'the last frame sent before quit is black',
    `${tail.length} trailing packets`)
} catch (error) {
  check(false, 'the run completed', String(error))
} finally {
  // Graded on every path, including an aborted run, because a page that threw
  // is the most useful thing this script can report and it is precisely what
  // the checks above cannot say. Each of them describes a wire symptom six
  // steps downstream of the throw that caused it.
  if (page !== null) {
    const raised = [...page.exceptions.values()]
    check(raised.length === 0, 'the page raised no uncaught exceptions',
      raised.map((e) => `x${e.count}  ${e.text}  ${e.where}`).join('\n          '))
  }
  page?.close()
  // `signalCode` as well as `exitCode`: a signal-killed child reports the
  // first and leaves the second null for ever, so waiting on `exitCode` alone
  // calls a clean teardown a leak. A warning that fires on every good run is a
  // warning nobody reads on the bad one.
  if (electron !== null && electron.exitCode === null && electron.signalCode === null) {
    // The group, not the shim — see `detached` above.
    try {
      process.kill(-electron.pid, 'SIGKILL')
    } catch {
      // Already gone, which is the outcome this wanted.
    }
    await sleep(300)
  }

  // Graded, not assumed. A leaked Electron does not spoil the run that leaks
  // it; it spoils the next one, silently, by being the app that run attaches
  // to. That is only catchable here, while the pid is still known.
  if (electron !== null) {
    let alive = false
    try {
      process.kill(-electron.pid, 0)
      alive = true
    } catch {
      alive = false
    }
    check(!alive, 'no Electron process survived the run',
      alive ? `process group ${electron.pid} is still running — kill it before re-running` : '')
  }
  tap.close()
  rmSync(workspace, { recursive: true, force: true })

  // The gate lock needs no release: it is a socket, and the kernel closes it
  // when this process ends, on every path including the ones that never reach
  // here.
}

console.log(failures.length === 0
  ? `\nAll ${stepNumber} wire checks passed.`
  : `\n${failures.length} of ${stepNumber} wire checks FAILED:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
