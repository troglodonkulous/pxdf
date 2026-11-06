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
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, delimiter } from 'node:path'
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
 * restart fine; controller 1, in Master/IR mode, reverts to the vendor's own
 * content at about five seconds (in slave mode it holds its last frame instead,
 * same as 2 and 3 — `CLAUDE.md` § The rig). Two seconds sits well inside that
 * worst case and still fails loudly on the case this bound exists for: a
 * restart that hangs on a Python process which will not exit, which on the
 * floor is somebody else's content mid-show.
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

/**
 * How long a default clip runs, in milliseconds.
 *
 * This file authors its own fixtures, so this is a known quantity rather than
 * something read back out of the app — which is what makes it usable as an
 * independent reference. Section 6b grades the timeline's rate against it and
 * this harness's own clock; asking the app how long its clip is would grade
 * the app against itself.
 *
 * `makeClip` takes an explicit length for the cases that need one (the loop
 * section wants a 1 s clip), and defaults to this so the sections that grade
 * against `CLIP_MS` keep a fixture it actually describes.
 */
const CLIP_MS = 3_000

function makeClip(directory, colour, seconds = CLIP_MS / 1_000) {
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
 * Rawvideo in AVI: `tools/oracle/media/09-gradient24-8x8_4P-10x5.avi` is this, and
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

/**
 * One clip's bytes, muxed twice with the `moov` atom at opposite ends.
 *
 * ## What this fixture is for
 *
 * `ddf-media://` served every request with `net.fetch` over a `file://` URL
 * until 2026-09-18, and that cannot answer a `Range` request: `bytes=0-` comes
 * back `200`, whole file, no `Content-Range`. The scheme is registered
 * `stream: true` and Chromium reports `kIsRangeHeaderSupported=true` for it, so
 * Chromium asked for ranges and was handed byte 0 every time. An MP4 whose
 * `moov` atom sits after `mdat` has to be read from the tail **to open at
 * all**, so those files never opened — 124/124 `moov`-at-front clips played and
 * 0/7 `moov`-at-end clips did across one night's job log, 105
 * `DEMUXER_ERROR_COULD_NOT_OPEN` lines.
 *
 * ## Why a pair, and why the pair is byte-identical
 *
 * The `front` clip is remuxed from the `end` one with `-c copy`, so the two
 * hold the same encoded frames and differ in nothing but atom order. That makes
 * `front` a **positive control**: if it does not play, something other than the
 * range fix is broken — the codec, the compositor, the authorisation — and the
 * `end` result says nothing at all. A single clip that failed would be
 * indistinguishable from an instrument that was broken.
 *
 * ## Why it is noisy white and not solid
 *
 * Two reasons at once. `tone()` needs to tell this clip from the red cue that
 * is live when it is fired, and near-white noise puts every byte of the
 * framebuffer above zero, which is the `white` band. And the clip has to be
 * *big* — a solid colour compresses to a handful of kilobytes, and a file small
 * enough to arrive whole in one read may well open without a single range
 * request ever being answered. Lossless noise gives about 3.4 MB from 1.5
 * seconds, in about a fifth of a second of `ffmpeg`.
 *
 * **The size that is actually required is not known.** Nobody has measured the
 * threshold at which a `moov`-at-end file stops opening over a handler that
 * cannot answer a range, and this fixture is sized to be comfortably above the
 * clips that failed in the field (the smallest was 5.5 MB) rather than to sit
 * at a measured edge. If this check ever passes with the fix reverted, this
 * number is the first thing to raise — and that would be the gate failing to
 * be a gate, not the bug being gone.
 *
 * ## The atom order is verified, not assumed
 *
 * `ffmpeg` writes `moov` last for this muxer and `+faststart` moves it first,
 * but a fixture whose atom order was assumed is a fixture that can silently
 * stop being the thing under test — an `ffmpeg` upgrade that changed the
 * default would leave this file grading two identical clips and reporting a
 * clean pass. `tools/moov_position.py` is an independent walker with its own
 * positive control; this refuses to run rather than grade an unverified pair.
 */
function makeMoovPair(directory) {
  const end = join(directory, 'moovend-white.mp4')
  const front = join(directory, 'moovfront-white.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=30:d=1.5',
    '-vf', 'noise=alls=24:allf=t+u',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', end,
  ])
  // `-c copy`, so `front` is the same encoded frames with the atoms reordered.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', end, '-c', 'copy', '-movflags', '+faststart', front,
  ])

  const order = (path) => {
    const printed = execFileSync(
      PYTHON, [join(REPO_ROOT, 'tools', 'moov_position.py'), path], { encoding: 'utf8' })
    const line = printed.split('\n').find((text) => text.endsWith(basename(path)))
    return line === undefined ? 'UNREADABLE' : line.split('\t')[0]
  }
  const endOrder = order(end)
  const frontOrder = order(front)
  if (endOrder !== 'END' || frontOrder !== 'FRONT') {
    throw new Error(
      `the moov fixtures are not what this file thinks they are: ` +
      `${basename(end)} reads ${endOrder} (want END), ${basename(front)} reads ${frontOrder} ` +
      `(want FRONT). Grading them would measure nothing.`)
  }
  return { end, front }
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
     * question a gate has to answer is *how long* — controller 1, in Master/IR
     * mode, reverts to the vendor's own content about five seconds after
     * packets stop (in slave mode it holds its last frame instead). Without
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

/**
 * The body of the first packet in `packets` carrying `header`, or `null`.
 *
 * Two packets are only comparable when they describe the same region of the
 * floor, and the 5-byte header is what says which: byte 1 is the controller,
 * byte 3 the port, and the low seven bits of byte 4 the packet's index within
 * that port's data (`mapper/frame.py:buffer_from_datagrams`). Comparing "a
 * packet from then" against "a packet from now" without pinning that would
 * compare two different strips of the floor and call the difference motion.
 *
 * `null` rather than an empty buffer when the header is absent, so a caller
 * cannot mistake "this region never arrived" for "this region is black" —
 * `Buffer.equals` on two empty buffers is `true`, which would turn a capture
 * that failed into a check that passed.
 */
function bodyWithHeader(packets, header) {
  const found = packets.find((packet) => packet.subarray(0, HEADER_LEN).equals(header))
  return found === undefined ? null : found.subarray(HEADER_LEN)
}

// ------------------------------------------------------- DevTools protocol

async function attachToPage(port = DEBUG_PORT) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
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
        /**
         * The raw protocol, for the checks that cannot be written as a script.
         *
         * Everything else in this file drives the UI by evaluating an
         * expression, and `element.click()` is enough for all of it — until the
         * thing being graded is focus. A scripted click does not focus, and a
         * scripted `KeyboardEvent` is untrusted and so has no default action at
         * all, which means a check built from either one would pass whether or
         * not the fix it grades is present. `Input.dispatchMouseEvent` and
         * `Input.dispatchKeyEvent` produce the real thing: focus moves, and
         * Space activates a focused button unless something stops it.
         */
        send,
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
 * A real left click at an element's centre, dispatched by the browser itself.
 *
 * `clickScript` and friends above call `element.click()`, which delivers the
 * `click` handler and nothing else — no `mousedown`, no focus change. That is
 * fine for every check that grades what a click *does*, and useless for the
 * ones below, which grade what a click *leaves behind*. Section 6i is the only
 * caller and should stay that way: this is slower, and it needs the element to
 * be on screen and unobscured, which a scripted click does not care about.
 */
async function realClick(page, selector, index = 0) {
  const box = await page.evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]
    if (element === undefined) throw new Error('no element for ${selector}[${index}]')
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) throw new Error('${selector}[${index}] has no box to click')
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    })
  }
  await sleep(200)
}

/**
 * A real key press, trusted, with its native default action intact.
 *
 * `text` is what separates a key that types from one that only navigates, and
 * it is also what makes Space activate a focused button — omit it and the
 * check that Space does *not* re-fire the last-touched control cannot fail.
 */
async function pressKey(page, { key, code, keyCode, text }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await page.send('Input.dispatchKeyEvent', { ...base, type: text === undefined ? 'rawKeyDown' : 'keyDown', text })
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  await sleep(200)
}

const SPACE = { key: ' ', code: 'Space', keyCode: 32, text: ' ' }
const ARROW_DOWN = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }
const TAB = { key: 'Tab', code: 'Tab', keyCode: 9 }

/**
 * Change a `<select>` the way the operator does.
 *
 * The native-setter dance is not ceremony — React tracks the last value it set
 * on the element instance, so a direct `select.value = x` is recorded as
 * "already seen" and the event that follows is discarded as a no-op. The event
 * is `change`: that is what React maps `onChange` to for a select, where it
 * uses `input` for a text field.
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
/**
 * The respawn storm, graded by counting spawns.
 *
 * MEASURED 2026-08-13: pulling the Ethernet with the app open relaunched
 * `mapper stream` once a second, forever, each launch dying on a socket it
 * could not bind and each death raising a macOS crash dialog. Nothing in the UI
 * said why, and the operator's way out was killing the app from a terminal.
 *
 * **The count is the whole check.** Every other observable — the status pill,
 * the wire, the banner — looks the same after five spawns as after five hundred,
 * so grading them would report a fix that had not happened. This substitutes a
 * stub for the Python binary that appends a line per launch and exits the way
 * the real sender now does, and reads the file.
 *
 * The assertion is that the count *stops*, not that it is one. The first spawn
 * happens before the first poll tick and the ladder gets a rung or two in
 * before the poll suspends it, so a small number is correct and expected; an
 * unbounded one is the defect. Sampling twice, eight seconds apart, is what
 * separates them — a single sample cannot tell a storm from a stopped storm.
 */
async function checkNoRespawnStorm(workspace) {
  const STORM_DEBUG_PORT = DEBUG_PORT + 1
  const spawnLog = join(workspace, 'spawns.log')
  const stub = join(workspace, 'fake-python.sh')
  // Stands in for `python -m mapper stream ...`: records the launch, complains
  // the way the real sender complains, and leaves with EXIT_NETWORK_GONE.
  writeFileSync(stub, [
    '#!/bin/sh',
    'echo spawn >> "$DDF_SPAWN_LOG"',
    'echo "floor NIC $DDF_LOCAL_IP unusable: [Errno 49] Can\'t assign requested address" >&2',
    'exit 3',
    '',
  ].join('\n'))
  chmodSync(stub, 0o755)
  writeFileSync(spawnLog, '')

  const countSpawns = () => readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length

  let child = null
  let stormPage = null
  try {
    child = spawn(
      resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
      [
        resolve(APP_DIR, 'dist', 'main.js'),
        `--remote-debugging-port=${STORM_DEBUG_PORT}`,
        `--user-data-dir=${join(workspace, 'storm-profile')}`,
      ],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          DDF_ADDRESS: '127.0.0.1',
          // A different port from the main run's, so a stray packet from this
          // one can never be counted as content by the tap.
          DDF_PORT: String(PORT + 1),
          DDF_PYTHON: stub,
          DDF_SPAWN_LOG: spawnLog,
          // TEST-NET-3 (RFC 5737). Reserved for documentation, so it is
          // guaranteed not to be assigned to any interface on this machine —
          // which is exactly the state a pulled cable leaves behind.
          DDF_LOCAL_IP: '203.0.113.9',
        },
        stdio: 'ignore',
        detached: true,
      },
    )

    stormPage = await attachToPage(STORM_DEBUG_PORT)
    await sleep(4_000)
    const settled = countSpawns()
    await sleep(8_000)
    const later = countSpawns()

    check(later === settled, 'a sender that cannot bind is not restarted for ever',
      `${settled} spawns by 4 s, ${later} by 12 s — unbounded means the storm is still running`)
    check(settled > 0 && settled < 12, 'the ladder gets a few attempts in before the poll suspends it',
      `${settled} spawns before it settled`)

    const banner = await stormPage.evaluate(
      "document.querySelector('.error-banner')?.textContent ?? ''",
    )
    check(String(banner).includes('203.0.113.9'),
      'the banner names the interface that went away',
      `banner read: ${JSON.stringify(banner)}`)
  } finally {
    stormPage?.close()
    if (child !== null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await sleep(300)
    }
  }
}

/**
 * Whether a persisted `lastMediaDir` re-authorises its folder after a
 * restart, with no picker interaction at all — the policy decision
 * `main.ts`'s `authorizedMediaDir` comment documents and this checks rather
 * than merely asserts.
 *
 * Reuses the exact `--user-data-dir` the main run wrote `settings.json`
 * into — a fresh profile would prove nothing, since an empty
 * `lastMediaDir` trivially "restores" to nothing. Run after the main run has
 * quit, so this is the only Electron holding that profile.
 */
async function checkLibrarySurvivesRestart(workspace, expectedFile) {
  const RESTART_DEBUG_PORT = DEBUG_PORT + 2
  let child = null
  let restartPage = null
  try {
    child = spawn(
      resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
      [
        resolve(APP_DIR, 'dist', 'main.js'),
        `--remote-debugging-port=${RESTART_DEBUG_PORT}`,
        // The SAME profile the main run used — this is the whole point.
        `--user-data-dir=${join(workspace, 'profile')}`,
      ],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          DDF_ADDRESS: '127.0.0.1',
          DDF_PORT: String(PORT + 2),
          // Deliberately absent: DDF_PICK_MEDIA. This run must not need to
          // pick anything to see the folder it already knows about.
        },
        stdio: 'ignore',
        detached: true,
      },
    )
    restartPage = await attachToPage(RESTART_DEBUG_PORT)
    const listing = await restartPage.evaluate(`
      (async () => {
        for (let attempt = 0; attempt < 25; attempt++) {
          const result = await window.ddf.listMediaDir()
          if (result !== null) return result
          await new Promise((r) => setTimeout(r, 200))
        }
        return null
      })()
    `)
    const names = listing === null ? [] : listing.files.map((path) => path.split('/').pop())
    check(listing !== null && names.includes(expectedFile),
      'a picked folder re-authorises itself after a restart, with no picker interaction',
      JSON.stringify(listing))
  } finally {
    restartPage?.close()
    if (child !== null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await sleep(300)
    }
  }
}

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

  /**
   * The folder the picker's clips live in.
   *
   * Cue Library widens `ddf-media://` from "files the operator individually
   * opened" to "files living in the folder the operator opened one from" —
   * see `authorizedMediaDir` in `main.ts`. Putting the picked clips in their
   * own subdirectory rather than loose in `workspace` is what makes that
   * widening something this file can actually grade: `unpicked`, below,
   * stays a genuine sibling of this folder rather than a sibling of the
   * files inside it, so "an unrelated file is still refused" keeps meaning
   * what it always meant once a folder-wide grant exists alongside the
   * individual one.
   */
  const libraryDir = join(workspace, 'library')
  mkdirSync(libraryDir)
  const clips = [makeClip(libraryDir, 'red'), makeClip(libraryDir, 'white')]
  // A container this build cannot demux, measured in `mediaFormats.ts`: rawvideo
  // in AVI, which is what every test pattern in this repo actually is. Seeded
  // through the picker like the others, because `DDF_PICK_MEDIA` bypasses the
  // dialog's extension filter — the filter is a courtesy, and the failed-cue
  // path is the thing that has to hold when something gets past it.
  //
  // If this check ever goes red saying the wire lit up, the likely cause is an
  // Electron upgrade that decodes AVI. That is a change to `mediaFormats.ts`'s
  // measured table, not a bug in the player. It also has to sit outside the
  // extension the Library listing accepts, so it doubles as proof that listing
  // filters by extension rather than by "every file in the folder."
  const undecodable = makeUndecodableClip(libraryDir)
  /**
   * A sibling of the two picked clips — same folder, never itself passed
   * through `DDF_PICK_MEDIA` or opened through the dialog. This is the file
   * the folder-wide grant exists for: the Library section is supposed to
   * list it and serve it because the folder it lives in was authorised when
   * its neighbours were picked, not because anyone opened it by name.
   *
   * Yellow, not blue. `tone`'s own header comment explains why red and blue
   * cannot be told apart from one packet: neither is RGB-aligned to the
   * packet framing. Yellow is two channels lit rather than one, which lands
   * in a different lit-byte fraction band — enough to prove distinct content
   * reached the wire without teaching `tone` a colour it has no other use
   * for.
   */
  const sibling = makeClip(libraryDir, 'yellow')
  // Outside `libraryDir` entirely — a sibling of the folder, not of the files
  // in it. Identical to the picked clips in every other respect, which is the
  // point: the only thing that decides whether it is served is whether it was
  // opened, or lives in a folder that was.
  const unpicked = makeClip(workspace, 'green')
  /**
   * The `moov`-at-end clip the range fix exists for, and its byte-identical
   * `moov`-at-front control. Outside `libraryDir` on purpose: both are
   * authorised by being picked, and putting them in the library folder would
   * change what `ddf:list-media-dir` lists, which section 6g grades exactly.
   */
  const moov = makeMoovPair(workspace)

  // Before the tap opens, and in its own Electron on its own ports, because
  // this one is deliberately launched broken and must not be mistaken for the
  // healthy run everything below grades.
  await checkNoRespawnStorm(workspace)

  // PR 3's engine half: loop and trim, seeded onto two more cues with no
  // editing UI at all — that UI lands with the merge from `app-player-layout`
  // (`docs/APP-PLAN.md`, "the inspector and trim-mode UI wait"). `DDF_CUE_SEED`
  // is a test-only, env-var-gated seam of exactly the shape `DDF_PICK_MEDIA`
  // already is: a JSON object keyed by picked path, read once in `main.ts` and
  // applied to a cue's `loop`/`trimStartMs`/`trimEndMs` at add time in
  // `PlayScreen.tsx`'s `addMedia` — nothing a real launch ever sets.
  //
  // `loopClip` is a plain 1 s clip; `loop: 2` gives it a 1,000 ms x 2 = 2,000 ms
  // hold. `trimClip` is red for 1.2 s then white then red again — trimmed to
  // start at 1,200 ms, its first frame on the wire has to be white, never the
  // red in-point.
  //
  // The third segment is what section 3c is graded on, and its length is not
  // arbitrary. A `loop: null` cue that froze on its last frame and one that is
  // looping put *byte-identical* packets on the wire for any clip of one solid
  // colour, so the fixture has to change over time or the check cannot fail.
  // Two equal halves after the in-point make the discrimination
  // phase-independent: any two samples exactly half a lap apart land in
  // opposite segments whatever the loop's phase happens to be when the
  // sampling starts, so the check does not depend on timing this file cannot
  // control.
  const TRIM_START_MS = 1_200
  const TRIM_SEGMENT_MS = 1_500
  /** The trimmed clip's own length: the two segments after the in-point. */
  const TRIMMED_CLIP_MS = TRIM_SEGMENT_MS * 2
  const loopClip = makeClip(workspace, 'white', 1)
  const trimClip = makeSplitClip(workspace, [
    ['red', TRIM_START_MS / 1_000],
    ['white', TRIM_SEGMENT_MS / 1_000],
    ['red', TRIM_SEGMENT_MS / 1_000],
  ])
  const cueSeed = {
    [loopClip]: { loop: 2, trimStartMs: 0, trimEndMs: null },
    [trimClip]: { loop: null, trimStartMs: TRIM_START_MS, trimEndMs: null },
  }

  await tap.listen()

  // Refuse to run with somebody else already on the wire — the UDP counterpart
  // of the debug-port check above. `npm run dev` sends to this same
  // 127.0.0.1:60001, and binding the port does not conflict with that, so the
  // tap happily records both senders interleaved. What that looks like
  // downstream is fractional packet counts ("21.9 packets per frame") and
  // half the packets all-zero, which reads as a compositor fault rather than as
  // a second app. Cost a run to work out once; it should never cost a second.
  await sleep(500)
  if (tap.packets.length > 0) {
    throw new Error(
      `${tap.packets.length} packets arrived on ${PORT} before this run started anything. ` +
      'Something else is sending — a leaked Electron, or `npm run dev` in another ' +
      'terminal. Stop it before trusting anything this script prints.',
    )
  }

  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [
      resolve(APP_DIR, 'dist', 'main.js'),
      `--remote-debugging-port=${DEBUG_PORT}`,
      // A throwaway profile, so the app's own `settings.json` cannot reach this
      // run. Without it the gate inherits whichever NIC the operator last
      // picked in the real app; on a machine where that interface is currently
      // unplugged, every wire check below fails for a reason that has nothing
      // to do with the code under test. A gate whose result depends on the
      // developer's saved preferences is a gate that flakes.
      `--user-data-dir=${join(workspace, 'profile')}`,
    ],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DDF_ADDRESS: '127.0.0.1',
        DDF_PORT: String(PORT),
        // The heartbeat is once a minute in every build anyone ships, and this
        // run lasts well under that — so without this the log section below
        // would be grading a channel that had never spoken, and would pass by
        // finding nothing. Turned down rather than faked: these are real
        // heartbeats from a real run, and the line says its own cadence
        // (`frames=N/5s`) so nothing downstream can mistake them for a
        // minute's counting.
        DDF_HEARTBEAT_SECONDS: '5',
        DDF_PICK_MEDIA: [...clips, undecodable, loopClip, trimClip, moov.front, moov.end].join(delimiter),
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

  // 1b-ii. The Network help panel opens, and Escape closes it.
  //
  //     Graded here because it could not be graded where it was built. The
  //     panel covers the window, and computer-use cannot verify the way out of
  //     it: an OS-level Escape does not arrive as a DOM `keydown` in this
  //     Electron, though `cmd+r` works, because that is a native menu
  //     accelerator rather than a page event. So the one instrument that can
  //     see it is this one.
  //
  //     `popover="auto"` gives click-outside dismissal for free but, measured
  //     in this build, not Escape — hence the explicit handler in
  //     `MappingScreen.tsx` that this check exists to keep honest.
  await page.evaluate(
    'document.querySelector(\'[aria-label="Why is the floor not receiving?"]\').click()')
  const helpOpen = await waitFor(
    'document.getElementById(\'network-help\').matches(\':popover-open\') ? 1 : 0')
  check(helpOpen === 1, 'the Network help panel opens')

  await page.evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  const helpClosed = await waitFor(
    'document.getElementById(\'network-help\').matches(\':popover-open\') ? 0 : 1')
  check(helpClosed === 1, 'Escape closes the Network help panel')

  // 1b-iii. The dropdown and the socket agree.
  //
  //     This is the invariant the NIC bug actually violated. The old code kept
  //     the selection in `MappingScreen`'s own state, which the surface switch
  //     destroys, and re-defaulted it to `interfaces[0]` on remount while the
  //     sidecar stayed bound to whatever the operator had really chosen. Both
  //     halves looked right in isolation; only their disagreement was wrong,
  //     and nothing compared them.
  //
  //     It holds for the unbound case too, which is what this run exercises:
  //     no `DDF_LOCAL_IP` means `mapper` gets no `--local-ip`, and the select
  //     has to say so rather than displaying the first interface as though it
  //     had been chosen.
  const nicAgrees = await waitFor(
    '(async () => (document.querySelector(\'[aria-label="Network interface"]\').value ' +
    '=== await window.ddf.getLocalIp()) ? 1 : 0)()')
  check(nicAgrees === 1, 'the Network dropdown shows the address the sender is bound to')

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
  //
  //    "+" now opens a menu rather than picking a file directly — `Upload` is
  //    the old behaviour with a new name in front of it, and `Create in
  //    editor` ships visible and disabled because the Edit surface does not
  //    exist on this branch. Both are graded here, not just clicked past:
  //    a menu that opened with the wrong items in it would still let the
  //    Upload click below succeed, so the items themselves have to be read.
  await page.evaluate(clickScript('[aria-label="Add cue"]'))
  const menuItems = await waitFor(
    "[...document.querySelectorAll('[role=\"menuitem\"]')].map((el) => ({ " +
    'text: el.textContent.trim(), disabled: el.disabled === true })).length > 0 ' +
    "? [...document.querySelectorAll('[role=\"menuitem\"]')].map((el) => ({ " +
    'text: el.textContent.trim(), disabled: el.disabled === true })) : null')
  const upload = Array.isArray(menuItems) ? menuItems.find((item) => item.text.startsWith('Upload')) : undefined
  const createInEditor = Array.isArray(menuItems)
    ? menuItems.find((item) => item.text.startsWith('Create in editor'))
    : undefined
  check(upload !== undefined && upload.disabled === false,
    'the + menu offers Upload, enabled', JSON.stringify(menuItems))
  check(createInEditor !== undefined && createInEditor.disabled === true,
    'Create in editor ships visible and disabled — the Edit surface is not built yet',
    JSON.stringify(menuItems))

  //    Where the menu opened, not just what is in it. A `popover` lives in the
  //    top layer, and the UA sheet's `position: fixed; inset: 0; margin: auto`
  //    centres an unstyled one in the *viewport* — this menu was opening in the
  //    middle of the preview, a screen away from the `+` that owns it. Every
  //    assertion above passed the whole time, because reading `[role=menuitem]`
  //    out of the DOM cannot see where the DOM is painted. Graded as geometry
  //    for that reason: the menu's top edge sits just under the trigger's
  //    bottom, and the two overlap horizontally.
  const menuBox = await page.evaluate(
    '(() => { const t = document.querySelector(".add-cue-trigger"); ' +
    'const m = document.querySelector(".add-menu"); ' +
    'if (t === null || m === null) return null; ' +
    'const a = t.getBoundingClientRect(); const b = m.getBoundingClientRect(); ' +
    'return { drop: Math.round(b.top - a.bottom), ' +
    'overlap: Math.round(Math.min(a.right, b.right) - Math.max(a.left, b.left)), ' +
    'onscreen: b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight }; })()')
  check(menuBox !== null && menuBox.drop >= 0 && menuBox.drop <= 12
    && menuBox.overlap > 0 && menuBox.onscreen === true,
    'the + menu opens anchored under the + it belongs to, fully on screen',
    JSON.stringify(menuBox))

  await page.evaluate(clickButtonScript('Upload'))
  // Polled, not slept. The picker is an IPC round trip and the rows are a React
  // render behind it, and a fixed wait that is long enough on a warm machine
  // reads zero cues on a cold one — grading a healthy app red. This file argues
  // for polling twice in its own comments and then did this.
  //
  // Seven, not three and no longer five: `red`, `white`, `undecodable`, then
  // `loopClip` and `trimClip` — rows 3 and 4, exercised in step 6 below — then
  // the `moov`-at-front control and the `moov`-at-end clip, rows 5 and 6, fired
  // by section 2d. Every one of them is appended, so every row index the rest
  // of this file already assumes (0, 1, 2, 3, 4) still holds.
  const cueCount = await waitFor(
    'document.querySelectorAll(".cue-row").length === 7 ? 7 : 0')
  check(cueCount === 7, 'all seven seeded cues land in the stack',
    `saw ${await page.evaluate('document.querySelectorAll(".cue-row").length')}`)

  // 2a-i. Thumbnails are real decoded frames, not a placeholder reused for
  //       every row. A `.cue-thumb img` existing on each row would pass for a
  //       single static image copy-pasted onto every cue — exactly the kind
  //       of conclusion that survives its own disproof `CLAUDE.md` warns
  //       about — so this reads the pixels back and checks that the red cue's
  //       thumbnail and the white cue's actually differ, by drawing each into
  //       an offscreen canvas and averaging its bytes. The third row
  //       (`rawvideo.avi`) gets no assertion: it cannot decode, so "no
  //       thumbnail" is the correct outcome for it, not a defect to grade.
  const averageBrightnessScript = (rowIndex) => `(async () => {
    const img = document.querySelectorAll('.cue-row')[${rowIndex}]?.querySelector('.cue-thumb img')
    if (!img) return null
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }))
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth || 40
    canvas.height = img.naturalHeight || 24
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2]
    return sum / (data.length / 4)
  })()`
  const redThumb = await waitFor(averageBrightnessScript(0))
  const whiteThumb = await waitFor(averageBrightnessScript(1))
  check(typeof redThumb === 'number' && typeof whiteThumb === 'number' && whiteThumb - redThumb > 100,
    'the first two cues show distinct, real thumbnails rather than a shared placeholder',
    `red-cue thumb avg ${redThumb} · white-cue thumb avg ${whiteThumb}`)

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

  // 2c. The protocol-level half of the folder-wide grant: a direct
  //     `ddf-media://` request for a sibling of the picked clips — never
  //     itself opened by name — bypassing the UI entirely. This is what "the
  //     Library can serve it" means at the layer that actually decides it;
  //     the DOM checks below only prove the UI *asks* correctly.
  const siblingUrl = `ddf-media://file${sibling.split('/').map(encodeURIComponent).join('/')}`
  const siblingResult = await page.evaluate(`
    new Promise((done) => {
      const v = document.createElement('video')
      v.muted = true
      v.crossOrigin = 'anonymous'
      v.addEventListener('error', () => done('refused'))
      v.addEventListener('loadeddata', () => done('SERVED'))
      setTimeout(() => done('TIMEOUT'), 4000)
      v.src = ${JSON.stringify(siblingUrl)}
      v.load()
    })
  `)
  check(siblingResult === 'SERVED',
    'a sibling of a picked file, in the same picked folder, is served though never opened by name',
    `handler returned ${siblingResult}`)

  // 2d. Range requests, which this handler could not answer until 2026-09-18.
  //
  //     Two layers, deliberately, because they fail differently. The first is
  //     the mechanism — status, headers and the actual bytes — read with
  //     `fetch` from inside the page, which is the only way to put a chosen
  //     `Range` header on a request here; a `<video>` element does not let you
  //     write one. The second is the operator-visible consequence: a
  //     `moov`-at-end clip fired as a cue, which is what 105 failed cues at the
  //     2026-09-05 job actually looked like. The mechanism check is the sharp
  //     one and the consequence check is the one that survives the mechanism
  //     changing shape, and `docs/APP-PLAN.md` is explicit that the second is
  //     what a gate is ultimately for.
  const redUrl = `ddf-media://file${clips[0].split('/').map(encodeURIComponent).join('/')}`
  const rangeProbe = await page.evaluate(`
    (async () => {
      const url = ${JSON.stringify(redUrl)}
      const read = async (init) => {
        const response = await fetch(url, init)
        return {
          status: response.status,
          bytes: new Uint8Array(await response.arrayBuffer()),
          type: response.headers.get('Content-Type'),
          length: response.headers.get('Content-Length'),
          contentRange: response.headers.get('Content-Range'),
          acceptRanges: response.headers.get('Accept-Ranges'),
          cors: response.headers.get('Access-Control-Allow-Origin'),
        }
      }
      const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i])
      const whole = await read(undefined)
      const middle = await read({ headers: { Range: 'bytes=64-127' } })
      const tail = await read({ headers: { Range: 'bytes=-16' } })
      const past = await read({ headers: { Range: 'bytes=' + (whole.bytes.length + 10) + '-' } })
      return {
        size: whole.bytes.length,
        whole: { ...whole, bytes: undefined },
        middle: { ...middle, bytes: undefined, matches: same(middle.bytes, whole.bytes.slice(64, 128)) },
        tail: { ...tail, bytes: undefined, matches: same(tail.bytes, whole.bytes.slice(whole.bytes.length - 16)) },
        past: { ...past, bytes: undefined, served: past.bytes.length },
      }
    })()
  `)

  // The check the whole change turns on. Three things have to be true together
  // and each of them is a separate way to be wrong: a `206` that carried the
  // whole file would be the old bug wearing a new status code, a
  // `Content-Range` that disagreed with the body would mislead the demuxer
  // about where it is in the file, and bytes from the wrong offset are exactly
  // what the old handler served — plausible, complete, and from position zero.
  check(rangeProbe !== null
    && rangeProbe.middle.status === 206
    && rangeProbe.middle.contentRange === `bytes 64-127/${rangeProbe.size}`
    && rangeProbe.middle.length === '64'
    && rangeProbe.middle.matches === true,
    'a Range request is answered with a 206 carrying exactly those bytes',
    `status ${rangeProbe?.middle?.status} · ${rangeProbe?.middle?.contentRange} · ` +
    `Content-Length ${rangeProbe?.middle?.length} · bytes match ${rangeProbe?.middle?.matches}`)

  // The suffix form, which is the one that actually matters to a `moov`-at-end
  // file: the demuxer reads the tail before it has read anything else. Read as
  // an absolute offset instead of a suffix it returns plausible bytes from the
  // wrong end of the file, and nothing downstream would name the mistake.
  check(rangeProbe !== null && rangeProbe.tail.status === 206 && rangeProbe.tail.matches === true,
    'a suffix range returns the end of the file, not the start of it',
    `status ${rangeProbe?.tail?.status} · ${rangeProbe?.tail?.contentRange} · ` +
    `bytes match ${rangeProbe?.tail?.matches}`)

  // A range past the end is 416 and not a 200. Serving the beginning of the
  // file to a client that asked for bytes beyond it is a wrong answer that
  // looks like a right one — the client has no way to notice.
  check(rangeProbe !== null
    && rangeProbe.past.status === 416
    && rangeProbe.past.contentRange === `bytes */${rangeProbe.size}`
    && rangeProbe.past.served === 0,
    'a range past the end of the file is refused with a 416 that names the size',
    `status ${rangeProbe?.past?.status} · ${rangeProbe?.past?.contentRange} · ` +
    `${rangeProbe?.past?.served} bytes served`)

  // `Accept-Ranges: bytes` used to be deliberately absent, because it would
  // have been a capability claim this handler could not honour. It can now, and
  // it is on the whole-file response as well as the partial ones — a client
  // learns whether it may ask from the first answer it gets, which is the 200.
  // `Content-Length` on that response is d10a575's fix and stays graded here:
  // without it Chromium treats the resource as an unbounded stream and races
  // its own EOF.
  check(rangeProbe !== null
    && rangeProbe.whole.status === 200
    && rangeProbe.whole.acceptRanges === 'bytes'
    && rangeProbe.middle.acceptRanges === 'bytes'
    && rangeProbe.whole.length === String(rangeProbe.size),
    'the whole-file answer still carries Content-Length, and now advertises ranges truthfully',
    `status ${rangeProbe?.whole?.status} · Accept-Ranges ${rangeProbe?.whole?.acceptRanges} · ` +
    `Content-Length ${rangeProbe?.whole?.length} of ${rangeProbe?.size}`)

  // The two paths must agree about what the file is. They are built from
  // different code — one streams the whole file, one streams a slice — and a
  // `Content-Type` that differed between them would surface as a clip that
  // plays whole and fails when seeked, which reads as flakiness rather than as
  // a bug. Asserted as equality *and* against the expected value: equal-and-
  // both-wrong is still wrong.
  check(rangeProbe !== null
    && rangeProbe.whole.type === rangeProbe.middle.type
    && rangeProbe.whole.type === 'video/mp4',
    'the 200 and the 206 report the same Content-Type for the same file',
    `200 said ${rangeProbe?.whole?.type} · 206 said ${rangeProbe?.middle?.type} · ` +
    `416 said ${rangeProbe?.past?.type}`)

  // `Access-Control-Allow-Origin` on every one of them, not only the 200.
  // Losing it costs a `SecurityError` on every frame from the moment the first
  // cue goes live — 60 a second, nothing on the wire, nothing saying why — and
  // a 206 that forgot it would fail on precisely the clips this change exists
  // for. It is also what lets this very check read a status at all: without it
  // the page gets an opaque CORS failure instead of a response.
  check(rangeProbe !== null
    && rangeProbe.whole.cors === '*'
    && rangeProbe.middle.cors === '*'
    && rangeProbe.tail.cors === '*'
    && rangeProbe.past.cors === '*',
    'the CORS header is on the 206 and the 416, not only on the 200',
    `200 ${rangeProbe?.whole?.cors} · 206 ${rangeProbe?.middle?.cors} · ` +
    `suffix ${rangeProbe?.tail?.cors} · 416 ${rangeProbe?.past?.cors}`)

  // 2d-i. A Range header is not a way around the authorisation check.
  //
  //       The two run in a fixed order in `main.ts` — `mediaPath`, then
  //       `allowedMedia`/`servableLibraryFile`, and only then is the `Range`
  //       header so much as read — and this is the check that says the order
  //       has not moved. It is graded on the same `unpicked` clip 2b uses, so
  //       the only difference between a pass here and a pass there is the
  //       header.
  //
  //       Either outcome counts as refused and both are named: the 403 carries
  //       no CORS header, so depending on how Chromium reports it the page sees
  //       either the status or an opaque CORS failure. What is not negotiable
  //       is the absence of a `Content-Range` — a refusal has a short body of
  //       its own ("not an opened file", 21 bytes, which is why this cannot be
  //       graded on a byte count), and only a served slice carries that header.
  const rangedOutsider = await page.evaluate(`
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(unpickedUrl)}, { headers: { Range: 'bytes=0-63' } })
        return {
          status: response.status,
          contentRange: response.headers.get('Content-Range'),
          body: (await response.text()).slice(0, 40),
        }
      } catch (error) {
        return { status: 'CORS-BLOCKED', contentRange: null, body: '', detail: String(error) }
      }
    })()
  `)
  check(rangedOutsider !== null
    && (rangedOutsider.status === 403 || rangedOutsider.status === 'CORS-BLOCKED')
    && rangedOutsider.contentRange === null,
    'a Range request for a file the operator never opened is still refused',
    `status ${rangedOutsider?.status} · Content-Range ${rangedOutsider?.contentRange} · ` +
    `body ${JSON.stringify(rangedOutsider?.body)}`)

  // 2d-ii. The consequence, on the wire, with the control that makes it mean
  //        something.
  //
  //        `moov.front` and `moov.end` hold the same encoded frames — one is a
  //        `-c copy` remux of the other — and differ only in where the `moov`
  //        atom sits. So the control is exact: if the FRONT clip does not play,
  //        the codec, the compositor or the authorisation is broken and the END
  //        result is not a measurement of anything. `CLAUDE.md` says to state
  //        that as a refusal rather than print a table of failures, so a failed
  //        control fails the END check explicitly with "not measured" rather
  //        than letting it run and be read.
  const fireAndWatch = async (rowIndex) => {
    await page.evaluate(clickRowScript(rowIndex))
    await page.evaluate(clickButtonScript('GO'))
    let seen = []
    for (let attempt = 0; attempt < 30 && countTone(seen, 'white') === 0; attempt++) {
      seen = await tap.window(200)
    }
    return {
      white: countTone(seen, 'white'),
      packets: seen.length,
      // Read after the wait above, so a banner that takes a sampling tick to
      // appear has had six seconds to do so. A bare read here would report a
      // failing cue as clean.
      banner: await page.evaluate('document.querySelector(".error-banner")?.textContent ?? null'),
    }
  }

  const moovFront = await fireAndWatch(5)
  const controlHolds = moovFront.white > 0 && moovFront.banner === null
  check(controlHolds,
    'POSITIVE CONTROL: the moov-at-front twin of the test clip plays',
    `${moovFront.white} white packets of ${moovFront.packets} · banner ${JSON.stringify(moovFront.banner)}`)

  if (!controlHolds) {
    check(false, 'a moov-at-end clip opens and reaches the wire',
      'NOT MEASURED — the positive control above failed, so this result would say ' +
      'nothing about ranges. Fix the control first.')
  } else {
    // Back to red first, so "white appeared" below is a statement about the
    // clip that was just fired rather than about the one still on the wire from
    // the control.
    await page.evaluate(clickRowScript(0))
    await page.evaluate(clickButtonScript('GO'))
    let backToRed = []
    for (let attempt = 0; attempt < 25 && countTone(backToRed, 'red') === 0; attempt++) {
      backToRed = await tap.window(200)
    }
    check(countTone(backToRed, 'red') > 0,
      'the wire is back on the red cue before the moov-at-end clip is fired',
      `red ${countTone(backToRed, 'red')} · white ${countTone(backToRed, 'white')}`)

    const moovEnd = await fireAndWatch(6)
    // The banner is the check that survives: a cue that cannot decode while
    // another is live leaves the *previous* cue's content on the wire, so "the
    // wire is lit" is not evidence of anything here. White on the wire and a
    // clear banner are two independent statements and both are asserted.
    check(moovEnd.white > 0,
      'a moov-at-end clip opens and reaches the wire',
      `${moovEnd.white} white packets of ${moovEnd.packets}`)
    check(moovEnd.banner === null,
      'no cue failure is reported for the moov-at-end clip',
      `banner ${JSON.stringify(moovEnd.banner)}`)
  }

  // Leave the stack as section 3 found it: cue 1 live, wire red. Section 3's
  // first check is that precondition, so this is restoring state rather than
  // asserting anything.
  await page.evaluate(clickRowScript(0))
  await page.evaluate(clickButtonScript('GO'))
  for (let attempt = 0; attempt < 25; attempt++) {
    if (countTone(await tap.window(200), 'red') > 0) break
  }

  // 6g and 6h — the Library surface and drag-reorder — run later, right
  // before the app quits. Both add or move cues in the stack, and every
  // section between here and there (3, 3b, 4a-4d, 6a-6f) assumes the exact
  // 7-cue [red, white, rawvideo, loop, trim, moov-front, moov-end]
  // arrangement `DDF_PICK_MEDIA` seeds this run with — 3b in particular
  // indexes rows 3 and 4, and 2d above indexes 5 and 6; running them here
  // would silently invalidate every assumption downstream instead of failing
  // loudly where the mistake was made. The two moov rows are appended last
  // for the same reason the loop and trim rows were: no existing index moves.

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

  // 3c. The clip restarts rather than freezing — a `loop: null` cue keeps
  //     moving after one clip length has elapsed.
  //
  //     What was wrong: nothing in the app ever restarted a clip. `video.loop`
  //     was false and the only wrap in `VideoSource.draw` was gated on
  //     `trimEndMs !== null`, a field no surface in the app can set. Every cue
  //     played once and froze on its last frame, under a `LOOP ∞` chip and a
  //     cue row rendering `∞`.
  //
  //     Why the checks above could not see it. Every wire check in this file
  //     grades what packets *contain* — lit, black, red, white, a packet count,
  //     a gap between arrivals. A frozen floor fails none of them: the render
  //     loop goes on composing the held frame and `Sidecar` goes on sending, so
  //     the wire stays lit, stays the right colour, stays the right shape and
  //     never gaps. 3b's own `loop: 2` advance is the same — the *stack*
  //     advances on a wall-clock hold whether or not the decoder underneath it
  //     ever replayed anything, so it grades the engine's arithmetic and is
  //     blind to the decoder. A held frame is still a frame on the wire. The
  //     only thing that separates the two floors is whether the bytes *change*.
  //
  //     Both samples are taken after the first play would have ended, and that
  //     is the load-bearing part of the design rather than caution. Anchoring
  //     the first sample at GO instead compares a mid-clip frame against a
  //     final frame — which differ on a frozen floor too, so the check would
  //     pass against the exact defect it exists to catch.
  //
  //     Half a lap apart, for the reason given at the fixture: it puts the two
  //     samples in opposite segments of the clip at every phase, so the result
  //     does not depend on how accurately this file guessed when the cue went
  //     live.
  const LOOP_SETTLE_MS = 300
  const SAMPLE_WINDOW_MS = 150

  //     Anchored on the wire going lit, not on the cue row going live. Those
  //     are different moments: the row is React's mirror of engine state and a
  //     cue is live the instant it is promoted, while the decoder may still be
  //     seeking to the in-point and producing nothing. On a loaded machine that
  //     gap ran past this section's whole margin and put both samples inside a
  //     still-black floor — which is identical to itself half a lap later, so
  //     the check went red reporting the harness's own impatience as a frozen
  //     floor. Observed, once, in a run whose loop-advance check (3b) was red
  //     for the same starvation.
  //
  //     Waiting for light instead removes the decoder's latency from the
  //     measurement entirely, and errs late: the anchor is at or after real
  //     playback start, which can only push the samples further past the end of
  //     the first play, never before it.
  let litAt = null
  for (let attempt = 0; attempt < 50 && litAt === null; attempt++) {
    if (anyLit(await tap.window(100))) litAt = Date.now()
  }
  check(litAt !== null, 'the looping cue puts light on the wire before it is sampled',
    litAt === null ? 'still black after 5 s — nothing below this line is a measurement' : 'lit')
  await sleep(Math.max(0, (litAt ?? Date.now()) + TRIMMED_CLIP_MS + LOOP_SETTLE_MS - Date.now()))

  const fromRestart = tap.packets.length
  const sampleAAt = Date.now()
  const windowA = await tap.window(SAMPLE_WINDOW_MS)
  await sleep(Math.max(0, TRIMMED_CLIP_MS / 2 - (Date.now() - sampleAAt)))
  const windowB = await tap.window(SAMPLE_WINDOW_MS)

  //     The positive control, and it is the whole reason the comparison below
  //     means anything: "the two bodies differ" is also satisfiable by a
  //     capture that produced nothing, because `null` is not equal to `null`
  //     here and two empty buffers compare equal. Refuse on an empty capture
  //     rather than grade one.
  const restartHeader = windowA.length > 0 ? windowA[0].subarray(0, HEADER_LEN) : null
  const bodyA = restartHeader === null ? null : bodyWithHeader(windowA, restartHeader)
  const bodyB = restartHeader === null ? null : bodyWithHeader(windowB, restartHeader)
  //     Lit, not merely present. Both fixtures fill the floor, so every strip
  //     of a real frame carries colour — a black body means the decoder was
  //     not producing, and two black bodies compare equal, so without this the
  //     black-floor case fails the *next* check with a message blaming the loop
  //     for the harness having sampled too early.
  const litBodies = bodyA !== null && bodyB !== null
    && bodyA.some((byte) => byte !== 0) && bodyB.some((byte) => byte !== 0)
  check(litBodies,
    'both restart captures hold the same lit region of the floor',
    `${windowA.length} and ${windowB.length} packets · ` +
    `bodies ${bodyA === null ? 'absent' : `${bodyA.length} bytes`} and ` +
    `${bodyB === null ? 'absent' : `${bodyB.length} bytes`}`)

  check(litBodies && bodyA !== null && bodyB !== null && !bodyA.equals(bodyB),
    'the floor is still changing one clip length after a loop: null cue went live',
    `sampled ${TRIMMED_CLIP_MS / 2} ms apart, both past the ${TRIMMED_CLIP_MS} ms clip; ` +
    `bodies ${bodyA !== null && bodyB !== null && bodyA.equals(bodyB) ? 'identical' : 'differ'}`)

  //     And the same fact stated the way an operator would: the clip's own
  //     content came back round. A floor frozen on this fixture's last frame is
  //     red for ever, so white reappearing is the restart itself.
  const acrossRestart = tap.packets.slice(fromRestart)
  check(countTone(acrossRestart, 'red') > 0 && countTone(acrossRestart, 'white') > 0,
    'both halves of the looping clip appear on the wire after it should have ended',
    `red ${countTone(acrossRestart, 'red')} · white ${countTone(acrossRestart, 'white')} ` +
    `of ${acrossRestart.length} packets`)

  // 3d. And PAUSE still holds the frame, which is the promise the restart above
  //     is the first thing in this app capable of breaking.
  //
  //     `compose` composites the live source on every frame whether or not the
  //     transport is paused — that is what keeps a *sent* frame on the floor
  //     rather than stopping the send — so `draw`'s wrap runs while paused. An
  //     unguarded wrap seeks a clip held at its out-point back to its in-point
  //     on the very next composite, and an `ended` queued as the operator
  //     pressed PAUSE answers with `play()`. Either one makes PAUSE jump the
  //     floor or resume it. `PlayerEngine.setPaused` promises the opposite in
  //     as many words.
  //
  //     Graded as the mirror of 3c, on the same cue, same helper, same spacing:
  //     bodies sampled half a lap apart must now be *identical*.
  //
  //     What this section does NOT grade, stated because its green would
  //     otherwise be read as covering it. The two guards in `VideoSource` fire
  //     only when the playhead is at or past the out-point, and PAUSE pressed
  //     from here lands at an arbitrary phase — almost always mid-lap, where a
  //     paused clip holds whether or not the guards exist. Measured, not
  //     assumed: removing both guards and re-running leaves every check in this
  //     section green. The window in which they matter is the frame or so
  //     between EOF and the restart, which is not targetable from outside the
  //     app, so it is graded in `videoSource.test.ts` ("a paused transport is
  //     not a restart") where the phase is set directly.
  //
  //     What it does grade is the contract around them, none of which had any
  //     wire coverage before: that PAUSE reaches the element at all, that the
  //     send continues while paused, and — the one check here that a mutation
  //     turns red — that resuming brings the loop back. That last is the trap
  //     this pair invites: a pause implemented as a permanent disarm passes
  //     every "held frame" check ever written and is the frozen floor of 3c
  //     with a button press in front of it.
  const pauseLabel = await page.evaluate(
    'document.querySelector(".transport-big-button")?.textContent ?? null')
  await page.evaluate(clickButtonScript('PAUSE'))
  const resumeLabel = await waitFor(
    'document.querySelector(".transport-big-button")?.textContent?.includes("RESUME") ? "RESUME" : null')
  //     The button's own label is the independent witness that the transport
  //     flipped. Without it a PAUSE that silently did nothing would still be
  //     graded by the identical-bodies check below — and would fail it, but for
  //     the wrong reason and with a message pointing at the decoder.
  check(pauseLabel !== null && pauseLabel.includes('PAUSE') && resumeLabel === 'RESUME',
    'PAUSE flips the transport and the button says so',
    `${JSON.stringify(pauseLabel)} -> ${JSON.stringify(resumeLabel)}`)

  //     Settle first: the click reaches the engine, the engine pauses the
  //     element, and the render loop composites one more frame from wherever
  //     the decoder actually stopped. Sampling before that grades the coast.
  await sleep(500)
  const pausedA = await tap.window(SAMPLE_WINDOW_MS)
  await sleep(TRIMMED_CLIP_MS / 2 - SAMPLE_WINDOW_MS)
  const pausedB = await tap.window(SAMPLE_WINDOW_MS)

  const pausedHeader = pausedA.length > 0 ? pausedA[0].subarray(0, HEADER_LEN) : null
  const pausedBodyA = pausedHeader === null ? null : bodyWithHeader(pausedA, pausedHeader)
  const pausedBodyB = pausedHeader === null ? null : bodyWithHeader(pausedB, pausedHeader)
  //     Non-empty is also the "PAUSE is not a teardown" check: the socket stays
  //     open and the sender keeps sending the held frame, because a floor that
  //     stops receiving is a floor that reverts to vendor content in Master/IR
  //     mode (`CLAUDE.md`, § The rig).
  check(pausedBodyA !== null && pausedBodyB !== null && pausedA.length > 0 && pausedB.length > 0,
    'the wire keeps carrying the held frame while paused — PAUSE is not a teardown',
    `${pausedA.length} and ${pausedB.length} packets`)

  check(pausedBodyA !== null && pausedBodyB !== null && pausedBodyA.equals(pausedBodyB),
    'a paused clip holds its frame instead of looping under the operator',
    `sampled ${TRIMMED_CLIP_MS / 2} ms apart; bodies ` +
    `${pausedBodyA !== null && pausedBodyB !== null && pausedBodyA.equals(pausedBodyB) ? 'identical' : 'differ'}`)

  //     Resume, and the loop has to come back. A pause that permanently
  //     disarmed the restart would pass every check above and be the original
  //     frozen floor with an extra button press in front of it.
  await page.evaluate(clickButtonScript('RESUME'))
  const backToPause = await waitFor(
    'document.querySelector(".transport-big-button")?.textContent?.includes("PAUSE") ? "PAUSE" : null')
  await sleep(300)
  const resumedA = await tap.window(SAMPLE_WINDOW_MS)
  await sleep(TRIMMED_CLIP_MS / 2 - SAMPLE_WINDOW_MS)
  const resumedB = await tap.window(SAMPLE_WINDOW_MS)
  const resumedHeader = resumedA.length > 0 ? resumedA[0].subarray(0, HEADER_LEN) : null
  const resumedBodyA = resumedHeader === null ? null : bodyWithHeader(resumedA, resumedHeader)
  const resumedBodyB = resumedHeader === null ? null : bodyWithHeader(resumedB, resumedHeader)
  check(backToPause === 'PAUSE' && resumedBodyA !== null && resumedBodyB !== null
      && !resumedBodyA.equals(resumedBodyB),
    'the clip loops again once the transport resumes',
    `button ${JSON.stringify(backToPause)}; bodies ` +
    `${resumedBodyA !== null && resumedBodyB !== null && resumedBodyA.equals(resumedBodyB) ? 'identical' : 'differ'}`)

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

  //     And the NIC selection survived the round trip. This is the exact
  //     sequence the operator reported: pick an interface, open the Player, come
  //     back, and find the dropdown pointing somewhere else while the sender was
  //     still bound where they left it. The Mapping surface has been unmounted
  //     and rebuilt between the two reads, which is what used to lose it.
  const nicSurvived = await waitFor(
    '(async () => (document.querySelector(\'[aria-label="Network interface"]\').value ' +
    '=== await window.ddf.getLocalIp()) ? 1 : 0)()')
  check(nicSurvived === 1,
    'the NIC selection still matches the binding after a trip through the Player')

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
  //     left the floor with no sender at all — controller 1, in Master/IR
  //     mode, reverting to the vendor's own content five seconds later,
  //     mid-show (in slave mode it would have held its last frame instead,
  //     same as 2 and 3 — either way, no sender is still no sender). It was
  //     reachable from a dropdown.
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

  // 4e. Back to Play for PR 2's layout gate. Section 4b-4d drove the Mapping
  //     surface's Floor selects, which leaves the app standing on Mapping —
  //     Navigation does not touch engine state (checked in 4a), so the cue
  //     that was live going into that detour is still live coming out of it.
  await page.evaluate(clickButtonScript('Open Player'))
  const backOnPlay = await waitFor('document.querySelector(".play-screen") !== null ? 1 : 0')
  check(backOnPlay === 1, 'Open Player returns to the Play surface after the Mapping detour')

  // 6. PR 2: bottom bar regrouped to global controls, the timeline reading
  //    clip position, Standby/GO/preview coupling, Tab, resizable sidebars
  //    and zoom past 100%. Six checks, matching the PR's Grade list exactly.

  // 6a. The bottom bar is global controls only, left to right in the order
  //     3a specifies: Master, Crossfade, PAUSE, BLACKOUT. Previous/Next and
  //     the per-cue timecode/progress bar are not decoration removed from
  //     here — they are what the new centre timeline panel (6b) replaces, so
  //     their absence from the bar is as load-bearing as the new order.
  const transportText = await page.evaluate('document.querySelector(".transport")?.textContent ?? ""')
  const barOrder = ['Master', 'Crossfade', 'PAUSE', 'BLACKOUT'].map((label) => transportText.indexOf(label))
  check(barOrder.every((index) => index >= 0) && barOrder.every((index, i) => i === 0 || index > barOrder[i - 1]),
    'the bottom bar holds Master, Crossfade, PAUSE, BLACKOUT in that order',
    `positions ${JSON.stringify(barOrder)} in ${JSON.stringify(transportText)}`)
  check(await page.evaluate('document.querySelector(\'.transport [aria-label="Previous cue"]\') === null'),
    'per-cue transport (Previous/Next) is no longer in the bottom bar')

  // 6b. The timeline reads clip position, not cue hold — the bug this PR
  //     fixes. The old bar read `elapsedMs / cueDurationMs`, and
  //     `cueDurationMs` is `null` for every hold-until-GO cue, so it sat at 0
  //     for most of the stack. Cue 2 (the white clip) is never seeded through
  //     `DDF_CUE_SEED` — only rows 3 and 4 are, in section 3b — so its `loop`
  //     is still `null`, `cueHoldMs` returns `null`, and it holds until GO.
  //     That is exactly the case the old bar could not move for.
  //
  //     Graded on *rate*, against this harness's own clock and `CLIP_MS`.
  //     Movement alone was never the claim: "goes up and does not freeze" is
  //     satisfied by a bar driven by any moving quantity, including the wrong
  //     one, which is the entire bug. Both references are outside the app —
  //     the clip is 3 s because this file builds it that way with ffmpeg, and
  //     the elapsed time is measured here — and Speed is fixed at 1x on this
  //     branch, so advance and elapsed have to agree.
  //
  //     The timecode beside the bar is the tempting reference and is wrong
  //     twice over: it renders at one-second resolution, so on a 3 s clip a
  //     single second of quantisation is 33 points of slack — enough for a bar
  //     at double or half rate to pass, measured — and it reads the same
  //     snapshot the bar does, so it is one instrument wearing two labels.
  //
  //     Wraps are counted rather than tripped over: the bar is a percentage of
  //     a looping clip, so advance is the sum of forward steps plus 100 per
  //     wrap. Two samples 1.2 s apart cannot do this at all — the first
  //     revision read `96 -> 29` and graded a healthy app red, because 1.2 s
  //     of a 3 s clip is 40 % of a lap and 96 % put a wrap inside the window.
  //
  //     The longest run of identical readings is graded alongside the rate,
  //     because neither catches what the other does. A bar that freezes and
  //     then jumps to catch up lands on exactly the right total advance; only
  //     the flat run sees it. A bar at double rate never repeats a reading;
  //     only the rate sees it.
  //     Preconditions established here, not inherited. An earlier revision of
  //     this section lost its three setup lines in an edit and stayed green,
  //     because cue 2 happened to still be live from section 6a — the check
  //     was grading whatever the previous section left behind, and would have
  //     gone on grading one of section 3b's *seeded* cues, which do have a
  //     hold, the moment anything upstream moved. That is the whole subject of
  //     the check chosen by accident.
  await page.evaluate(clickRowScript(1))
  await page.evaluate(clickButtonScript('GO'))
  const liveForTimeline = await waitForLive(1)
  //     Both halves of "hold-until-GO cue is live" asserted, because each can
  //     fail without the other.
  //
  //     The tell used to be the absence of the duration *input*. The merge with
  //     `app-cue-timing` deleted that field from the app entirely, which left
  //     `=== null` vacuously true — an assertion that can no longer tell "this
  //     cue holds" from "the field was removed", which is the positive-control
  //     failure `CLAUDE.md` names. Re-expressed against what the v2 model
  //     actually renders: the live row's `.cue-duration` badge is
  //     `formatTimecode(cueHoldMs(cue))`, and `cueHoldMs` returns `null` —
  //     printed `∞` — exactly when a cue holds until GO. A seeded cue reads a
  //     timecode there instead, so pointing this at row 3 or 4 goes red, which
  //     is how it was mutation-checked. `null` means no badge at all (the row
  //     is showing Standby, or nothing is live), and fails rather than passing
  //     quietly.
  const holdBadge = await page.evaluate(
    'document.querySelector(".cue-row.is-live .cue-duration")?.textContent ?? null')
  check(liveForTimeline === 1 && holdBadge === '∞',
    'the cue under the timeline is live and still hold-until-GO',
    `live row ${liveForTimeline}, hold badge ${JSON.stringify(holdBadge)}`)
  const clipPosition = () => page.evaluate(
    'Number(document.querySelector(\'[aria-label="Clip position"]\')?.getAttribute("aria-valuenow") ?? "-1")')
  const positions = []
  const startedAt = Date.now()
  for (let sample = 0; sample < 10; sample++) {
    positions.push(await clipPosition())
    await sleep(300)
  }
  const elapsedMs = Date.now() - startedAt - 300
  let advance = 0
  for (let index = 1; index < positions.length; index++) {
    const step = positions[index] - positions[index - 1]
    advance += step >= 0 ? step : step + 100
  }
  const expected = (elapsedMs / CLIP_MS) * 100
  //     React republishes engine state on a tick of at least 250 ms, so any
  //     sample can be that stale — 8 points on a 3 s clip — and the bar rounds
  //     on top. The band is derived from that rather than picked: two ticks'
  //     worth either way, plus rounding. It still rejects half rate (~45
  //     points against ~90 expected) and double (~180) by a wide margin.
  const band = (500 / CLIP_MS) * 100 + 2
  let flatRun = 1
  let longestFlatRun = 1
  for (let index = 1; index < positions.length; index++) {
    flatRun = positions[index] === positions[index - 1] ? flatRun + 1 : 1
    if (flatRun > longestFlatRun) longestFlatRun = flatRun
  }
  //     The flat-run grade stays alongside the rate. A bar that freezes and
  //     then jumps to catch up has the right total advance and is still a
  //     broken bar; averages hide stalls that a run of identical readings does
  //     not.
  check(positions.length === 10 && positions.every((value) => value >= 0)
    && Math.abs(advance - expected) <= band && longestFlatRun <= 2,
    'the timeline advances for a hold-until-GO cue, driven by clip position',
    `${positions.join(' -> ')} · advanced ${advance} points in ${elapsedMs} ms, ` +
    `expected ${expected.toFixed(1)} ± ${band.toFixed(1)} for a ${CLIP_MS} ms clip, ` +
    `longest flat run ${longestFlatRun}`)

  // 6c. Tab toggles Live/Preview, and does not fight a focused text field —
  //     blurring first so a stray focus left over from any earlier text input
  //     in this run cannot make the toggle a no-op.
  await page.evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()')
  const modeBeforeTab = await page.evaluate('document.querySelector(".player-shell")?.className ?? ""')
  const pressTab = () => page.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    return true
  })()`)
  await pressTab()
  const modeAfterTab = await waitFor(`(() => {
    const cls = document.querySelector('.player-shell')?.className ?? ''
    return cls !== ${JSON.stringify(modeBeforeTab)} ? cls : null
  })()`)
  check(modeBeforeTab.includes('mode-live')
      && typeof modeAfterTab === 'string' && modeAfterTab.includes('mode-preview'),
    'Tab flips the player shell from Live to Preview', `${modeBeforeTab} -> ${modeAfterTab}`)

  // Back to Live, so every check after this one runs in the mode the rest of
  // the file assumes.
  await pressTab()
  const modeBackToLive = await waitFor(
    'document.querySelector(".player-shell")?.className.includes("mode-live") ? "live" : null')
  check(modeBackToLive === 'live', 'Tab flips back from Preview to Live', String(modeBackToLive))

  // 6d. Clicking the live cue's own row parks Standby there rather than
  //     leaving it wherever it was, and GO greys out — firing Standby here
  //     would restart the cue already on the floor, which is not what a
  //     click on the live row means. The Standby badge is hidden on that row
  //     too, since the row is already marked live and a second badge saying
  //     "Standby" on the same row is not information, it is the same fact
  //     twice under two different names.
  const liveRowForGo = await page.evaluate(liveIndex)
  await page.evaluate(clickRowScript(liveRowForGo))
  const goDisabledAfterSelf = await waitFor(
    'document.querySelector(".go-button")?.disabled === true ? "disabled" : null')
  check(goDisabledAfterSelf === 'disabled', 'GO is disabled when Standby is parked on the live cue',
    String(await page.evaluate('document.querySelector(".go-button")?.disabled ?? null')))
  check(await page.evaluate(
    `document.querySelectorAll('.cue-row')[${liveRowForGo}]?.querySelector('.standby-marker') === null`),
    'the Standby badge is hidden on a row that is both live and standby')

  // 6e. A gutter drag resizes the sidebar, live, through the same
  //     `--w-sidebar` token the design system already sizes the cue stack
  //     from — a new writer of an existing value, not a new layout
  //     mechanism. Dispatched on `window` after `pointerdown`, not relying on
  //     `setPointerCapture` alone: a scripted `PointerEvent` here has no real
  //     active pointer for the browser to capture, and a resize that only
  //     works for a mouse the OS is tracking is not one this gate can drive.
  const widthBeforeDrag = await page.evaluate(
    'getComputedStyle(document.querySelector(".player-shell")).getPropertyValue("--w-sidebar").trim()')
  await page.evaluate(`(() => {
    const gutter = document.querySelector('[data-gutter="sidebar"]')
    if (gutter === null) throw new Error('no sidebar gutter')
    const rect = gutter.getBoundingClientRect()
    const startX = rect.left + rect.width / 2
    gutter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: startX }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: startX + 60 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: startX + 60 }))
    return true
  })()`)
  const widthAfterDrag = await waitFor(`(() => {
    const w = getComputedStyle(document.querySelector('.player-shell')).getPropertyValue('--w-sidebar').trim()
    return w !== ${JSON.stringify(widthBeforeDrag)} ? w : null
  })()`)
  check(typeof widthAfterDrag === 'string' && widthAfterDrag !== widthBeforeDrag,
    'dragging the sidebar gutter changes --w-sidebar', `${widthBeforeDrag} -> ${widthAfterDrag}`)

  // 6f. Layout must not touch the render loop. The gutter drag above and a
  //     zoom change here happen while a cue is live, and neither may gap or
  //     black the wire — a resize handler or a zoom recompute that touched
  //     the compose/writeFrame path would be exactly the kind of defect
  //     `docs/APP-PLAN.md` describes for the render loop: silent, and
  //     invisible to anything that is not watching the wire itself.
  const beforeLayoutChange = tap.packets.length
  await page.evaluate(clickScript('[aria-label="Zoom in"]'))
  await page.evaluate(clickScript('[aria-label="Zoom in"]'))
  await sleep(600)
  const acrossLayoutChange = tap.packets.slice(beforeLayoutChange)
  check(acrossLayoutChange.length > 0 && countTone(acrossLayoutChange, 'black') === 0,
    'the wire stays unbroken across the sidebar resize and a zoom change',
    `${countTone(acrossLayoutChange, 'black')} of ${acrossLayoutChange.length} packets were all-zero`)
  await page.evaluate(clickButtonScript('Fit'))

  // 6g. The Cue Library surface. Ordered after 6a-6f deliberately, not by
  //     accident of the merge: this block appends a cue and then reorders
  //     the stack, and 6b asserts that the cue under the timeline is cue 2 and
  //     still hold-until-GO. Run the other way round, 6b would be grading
  //     whichever cue the Library left live — the exact substitution its
  //     precondition exists to catch.
  //
  //     Nothing after this point reads cue-stack structure: section 5 only
  //     checks that quitting sends black, which `Sidecar.stop()` does
  //     unconditionally regardless of what was live. The navigation back to
  //     Play that this block used to open with is now done once, above, by
  //     the block that runs first.
  //     `ddf:list-media-dir` takes no path from the renderer — the main
  //     process answers with its own idea of the authorised folder. That is
  //     the property that keeps the handler from being a read-any-directory
  //     primitive handed to the untrusted side of `contextIsolation`; a
  //     handler that took a directory argument would pass every check below
  //     just as well while being a different, much worse, feature.
  const listing = await page.evaluate('window.ddf.listMediaDir()')
  const listedNames = listing === null ? [] : listing.files.map((path) => path.split('/').pop()).sort()
  check(listing !== null && typeof listing.dir === 'string' && listing.dir.endsWith('/library'),
    'ddf:list-media-dir answers with the folder the operator actually picked from',
    JSON.stringify(listing))
  // Derived from the fixtures this file authored rather than spelled out, so a
  // change to how `makeClip` names its output cannot make this check wrong
  // while leaving it green. The three are the servable clips in `libraryDir`;
  // `undecodable` lives there too and must not appear, and `unpicked` lives
  // outside it and must not either.
  const servableNames = [...clips, sibling].map((path) => path.split('/').pop()).sort()
  check(JSON.stringify(listedNames) === JSON.stringify(servableNames),
    'the listing holds exactly the PICKER_EXTENSIONS files in that folder — not the AVI, not the outsider',
    `${JSON.stringify(listedNames)} · want ${JSON.stringify(servableNames)}`)

  // The DOM side of the same fact: the collapsible Library section, expanded,
  // shows one row per listed file.
  await page.evaluate(clickButtonScript('Library'))
  const libraryRowCount = await waitFor(
    'document.querySelectorAll(".library-row").length === 3 ? 3 : 0')
  check(libraryRowCount === 3, 'the Library section lists the three servable files',
    `saw ${await page.evaluate('document.querySelectorAll(".library-row").length')}`)

  // Clicking the sibling clip — never picked, never opened by name — adds a
  // cue, and that cue has to actually play: listed-but-unservable would be a
  // library that lies to the operator about what GO will do.
  //
  // Counted relative to whatever the stack already holds rather than against a
  // literal. `DDF_PICK_MEDIA` seeds five cues on the merged tree and seeded
  // three before `app-cue-timing` added its loop and trim clips; a hard-coded
  // "4" grades the seed count, not the Library.
  const cueCountBeforeLibrary = await page.evaluate('document.querySelectorAll(".cue-row").length')
  const addedIndex = cueCountBeforeLibrary
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.library-row')]
      .find((el) => el.textContent.includes('yellow'))
    if (!row) throw new Error('no library row for the yellow clip')
    row.click()
    return true
  })()`)
  const cueCountAfterLibrary = await waitFor(
    `document.querySelectorAll(".cue-row").length === ${cueCountBeforeLibrary + 1} ? ${cueCountBeforeLibrary + 1} : 0`)
  check(cueCountAfterLibrary === cueCountBeforeLibrary + 1, 'clicking a Library row adds a cue to the stack',
    `saw ${await page.evaluate('document.querySelectorAll(".cue-row").length')}, want ${cueCountBeforeLibrary + 1}`)

  // A Library cue is added by a different click than the picker's, and for a
  // while it was built by a different piece of code too — its own `Cue`
  // literal, with no duration probe behind it. Nothing downstream noticed:
  // `mediaDurationMs` stayed null for the life of the show, so the inspector
  // read `—` forever and setting Loop on such a cue gave `cueHoldMs` a null
  // duration to multiply, which the engine reads as "never advance". Both
  // paths route through `addCuesFromPaths` now; this is the check that says so.
  // Same shape as 3b's probe check, on the other entry point.
  const libraryProbed = await waitFor(
    'document.querySelector(".cue-duration-readout")?.textContent !== "—" ? "probed" : ""')
  check(libraryProbed === 'probed', 'a cue added from the Library gets its duration probed too',
    String(await page.evaluate('document.querySelector(".cue-duration-readout")?.textContent ?? null')))

  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    rows[${addedIndex}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  const libraryLive = await waitFor(
    `[...document.querySelectorAll(".cue-row")][${addedIndex}]?.classList.contains("is-live") ? 1 : 0`)
  check(libraryLive === 1, 'the cue added from the Library becomes live')
  let fromLibrary = []
  for (let attempt = 0; attempt < 25 && countTone(fromLibrary, 'other') === 0; attempt++) {
    fromLibrary = await tap.window(200)
  }
  check(countTone(fromLibrary, 'other') > 0,
    'the Library cue reaches the wire as real, distinct content',
    `other ${countTone(fromLibrary, 'other')} of ${fromLibrary.length} packets`)

  // 6h. Drag-to-reorder, over `playHelpers.ts`'s `moveCue` generalised to an
  //     arbitrary index — `playHelpers.test.ts` grades the function; this
  //     grades that the row wiring actually calls it. Constructed
  //     `DragEvent`s with a real `DataTransfer`, not a mouse-drag simulation:
  //     HTML5 drag-and-drop fires its own event sequence and a page script can
  //     dispatch it directly without needing OS-level trust, which is exactly
  //     what a *programmatic* drag is for.
  const cueNamesScript =
    "[...document.querySelectorAll('.cue-row .cue-name')].map((el) => el.textContent)"
  const namesBeforeDrag = await page.evaluate(cueNamesScript)
  // Dispatched exactly once — deliberately outside `waitFor`, whose retry
  // loop re-evaluates its expression on every poll. A drag dispatch living
  // inside that loop would fire again on every unsuccessful attempt, which
  // on a slow render would reorder the stack more than once and this check
  // would be grading a different mutation than the one it dispatched.
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    const from = rows[rows.length - 1]
    const to = rows[0]
    if (!from || !to) throw new Error('missing row for drag')
    const dataTransfer = new DataTransfer()
    const fire = (type, target) => target.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
    fire('dragstart', from)
    fire('dragover', to)
    fire('drop', to)
    fire('dragend', from)
    return true
  })()`)
  const namesBeforeDragJson = JSON.stringify(JSON.stringify(namesBeforeDrag))
  const namesAfterDrag = await waitFor(`(() => {
    const after = ${cueNamesScript}
    return JSON.stringify(after) !== ${namesBeforeDragJson} ? after : null
  })()`)
  const expectedAfterDrag = [namesBeforeDrag[namesBeforeDrag.length - 1], ...namesBeforeDrag.slice(0, -1)]
  check(Array.isArray(namesAfterDrag) && JSON.stringify(namesAfterDrag) === JSON.stringify(expectedAfterDrag),
    'dragging the last row onto the first reorders the cue stack',
    `before ${JSON.stringify(namesBeforeDrag)} · after ${JSON.stringify(namesAfterDrag)}`)

  // 6i. Focus and selection. Three separate defects, one theme: the app kept
  //     state on whatever the operator last touched, and a console must not.
  //     Driven with real CDP input rather than `element.click()`, because
  //     every one of these is invisible to a scripted event — see `realClick`.
  const rowReadout = `(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    return {
      rows: rows.map((row, index) => ({
        index,
        name: row.querySelector('.cue-name')?.textContent ?? '',
        live: row.classList.contains('is-live'),
        selected: row.classList.contains('is-selected'),
        standby: row.classList.contains('is-standby'),
        // Two separate ways a row can read as picked: our own accent bar, and
        // the shared focus ring. Both are the same accent colour, so to the
        // operator they are the same claim, and the screenshot this section
        // exists for is one of each on two different rows.
        ring: row.matches(':focus-visible') || getComputedStyle(row).outlineStyle !== 'none',
      })),
      inspector: document.querySelector('.cue-summary strong')?.textContent ?? '',
      focused: document.activeElement === null ? 'none'
        : document.activeElement.tagName + '.' + document.activeElement.className,
    }
  })()`
  const blackoutLabel = 'document.querySelector(".transport-blackout")?.textContent ?? ""'

  // 6i-a. Space is GO even when a button holds keyboard focus. The handler
  //       used to bail out whenever the event target was a <button>, so that
  //       Space kept doing its native job of activating the focused control:
  //       click BLACKOUT, press Space, and the show does not advance while
  //       BLACKOUT quietly toggles instead. Focus is set here with `.focus()`
  //       on purpose — that is the keyboard route, which 6i-b's fix leaves
  //       intact, and it is the only route left that can still put focus on a
  //       transport button at all. Without it this check would be graded
  //       against an app where nothing is ever focused, and could not fail.
  const beforeSpace = await page.evaluate(rowReadout)
  const goTarget = beforeSpace.rows.find((row) => !row.live && !row.name.includes('rawvideo'))
  check(goTarget !== undefined, 'there is a decodable non-live cue to fire with Space',
    JSON.stringify(beforeSpace.rows.map((row) => `${row.index}:${row.name}${row.live ? '(live)' : ''}`)))
  await realClick(page, '.cue-row', goTarget.index)
  const focusedBlackout = await page.evaluate(`(() => {
    const button = document.querySelector('.transport-blackout')
    if (button === null) throw new Error('no BLACKOUT button')
    button.focus()
    return document.activeElement === button
  })()`)
  const blackoutBeforeSpace = await page.evaluate(blackoutLabel)
  await pressKey(page, SPACE)
  // The live class is React's mirror of engine state on a >=250 ms tick, so
  // this polls. A single read 200 ms after the key press reported "GO never
  // fired" against a build where it had.
  const liveAfterSpace = await waitForLive(goTarget.index)
  const blackoutAfterSpace = await page.evaluate(blackoutLabel)
  check(focusedBlackout === true && liveAfterSpace === goTarget.index,
    'Space fires GO while a transport button holds focus',
    `focused BLACKOUT ${focusedBlackout} · wanted live row ${goTarget.index}, got ${liveAfterSpace}`)
  check(blackoutAfterSpace === blackoutBeforeSpace,
    'Space does not also activate the button that held focus',
    `BLACKOUT read "${blackoutBeforeSpace}" before and "${blackoutAfterSpace}" after`)

  // 6i-b. A clicked control does not stay armed. `mousedown`'s default action
  //       is what focuses a button, so the transport refuses it and focus stays
  //       where it was — the click still lands. Graded on the operator-visible
  //       consequence rather than on the handler: after clicking, nothing on
  //       the transport is focused, so no later keystroke can be swallowed by
  //       it and no focus ring can appear on it.
  //
  //       The blur is load-bearing: 6i-a above deliberately parks focus on this
  //       exact button and `preventDefault` on `mousedown` refuses to *move*
  //       focus, it does not take focus away from something that already has
  //       it. Without this line the check reads back 6i-a's own setup and
  //       reports a red that says nothing about the click — which is what it
  //       did on the first run of this section.
  await page.evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()')
  await realClick(page, '.transport-blackout')
  const afterBlackoutClick = await page.evaluate(rowReadout)
  const blackoutTookEffect = await page.evaluate(blackoutLabel)
  await realClick(page, '.transport-blackout')
  const blackoutReleased = await waitFor(
    `${blackoutLabel} === 'BLACKOUT' ? 'released' : null`)
  check(blackoutTookEffect === 'BLACKOUT ACTIVE' && blackoutReleased === 'released',
    'the click still reaches BLACKOUT with its focus suppressed',
    `${blackoutBeforeSpace} -> ${blackoutTookEffect} -> ${blackoutReleased}`)
  check(!afterBlackoutClick.focused.includes('transport-'),
    'clicking a transport button leaves nothing focused',
    `activeElement was ${afterBlackoutClick.focused}`)

  // 6i-c. Exactly one thing looks selected. `.cue-row` was a <button> until
  //       2026-08-15, which made it focusable, which let the shared
  //       `button:focus-visible` rule paint a full accent outline on it.
  //       Chromium withholds that ring on a mouse click but re-arms it on the
  //       next keypress at the focused element — so click a row, then press the
  //       ↓ the standby helper row literally advertises, and the clicked row
  //       lights up in the same accent as the *other* row's selection bar.
  //       That sequence is what this reproduces, and `role="option"` on a div
  //       is what removes it: not focusable, so the ring has nowhere to land.
  await realClick(page, '.cue-row', goTarget.index)
  await pressKey(page, ARROW_DOWN)
  const afterArrow = await page.evaluate(rowReadout)
  const marked = afterArrow.rows.filter((row) => row.selected || row.ring)
  check(marked.length === 1, 'exactly one cue row carries a selection affordance',
    `${marked.length} marked: ${JSON.stringify(marked.map(
      (row) => `${row.index}:${row.name}${row.selected ? ' selected' : ''}${row.ring ? ' ring' : ''}`))}` +
    ` · activeElement ${afterArrow.focused}`)

  // 6i-d. The selection bar, the inspector and Standby all name one cue: the
  //       one that was clicked, in both modes. `selectCueTarget` used to
  //       re-target the *next* cue when the live row was clicked in Preview,
  //       which aimed rename, rotate, move and delete one row below the
  //       operator's click and put a second row's name in the inspector. Every
  //       selection path is walked, because the divergence appeared on one.
  //
  //       Standby is graded in Live only, and that is the engine's contract
  //       rather than a hole in this check: `engine.selectCue` arms Standby in
  //       Live and *auditions* in Preview (`engine.ts:355`), deliberately
  //       leaving whatever GO is aimed at alone while the operator previews
  //       something else. So Preview asserts the other half — that selecting
  //       does not move Standby — which is a thing this check can still be
  //       wrong about, rather than a clause quietly dropped because it was red.
  //       MEASURED 2026-08-15: the first version of this section asserted
  //       Standby follows the click in Preview too and failed on exactly that,
  //       against an app whose actual defect was already fixed.
  const selectionPaths = []
  for (const mode of ['live', 'preview']) {
    if (mode === 'preview') await pressTab()
    const shell = await waitFor(
      `document.querySelector('.player-shell')?.className.includes('mode-${mode}') ? '${mode}' : null`)
    const state = await page.evaluate(rowReadout)
    const standbyBefore = state.rows.filter((row) => row.standby).map((row) => row.index)
    const liveRow = state.rows.find((row) => row.live)
    const otherRow = state.rows.find((row) => !row.live)
    for (const row of [liveRow, otherRow]) {
      await realClick(page, '.cue-row', row.index)
      const seen = await page.evaluate(rowReadout)
      selectionPaths.push({
        path: `${mode}/${row.live ? 'live row' : 'other row'} ${row.index} "${row.name}"`,
        shell,
        selected: seen.rows.filter((r) => r.selected).map((r) => r.index),
        standby: seen.rows.filter((r) => r.standby).map((r) => r.index),
        wantStandby: mode === 'live' ? [row.index] : standbyBefore,
        inspector: seen.inspector,
        want: row.index,
        wantName: row.name,
      })
    }
  }
  await pressTab()
  const backToLive = await waitFor(
    'document.querySelector(".player-shell")?.className.includes("mode-live") ? "live" : null')
  const divergent = selectionPaths.filter((p) => p.shell === null
    || JSON.stringify(p.selected) !== JSON.stringify([p.want])
    || JSON.stringify(p.standby) !== JSON.stringify(p.wantStandby)
    || p.inspector !== p.wantName)
  check(selectionPaths.length === 4 && divergent.length === 0 && backToLive === 'live',
    'the selection bar, the inspector and Standby all name the clicked cue',
    divergent.length === 0
      ? `${selectionPaths.length} paths walked, back on ${backToLive}`
      : divergent.map((p) => `${p.path}: selected ${JSON.stringify(p.selected)}, ` +
        `standby ${JSON.stringify(p.standby)} wanted ${JSON.stringify(p.wantStandby)}, ` +
        `inspector "${p.inspector}"`).join(' · '))

  // 6i-e. The listbox is operable, not just correctly shaped. 6i-c takes focus
  //       off the rows; that is only half a widget, and the missing half is
  //       not a smaller feature but a broken one — a `role="listbox"` with
  //       nowhere for focus to land and no `aria-activedescendant` announces
  //       itself to assistive tech as a list of options it then cannot reach.
  //       A code review caught it after the first four commits; this is the
  //       check that would have.
  //
  //       Graded on the consequence an AT user gets rather than on the
  //       attributes in isolation: focus can enter the list, and the option it
  //       reports as active is the same row the sighted operator sees the
  //       accent bar on. Reading the attribute alone would stay green against
  //       an id that resolves to nothing.
  //
  //       What `tabIndex` buys here is *not* sequential Tab navigation, and an
  //       earlier version of this check said it was. Tab never traverses this
  //       surface at all: the window handler consumes every one of them for
  //       the Live/Preview toggle (`PlayScreen.tsx:353`), which is settled
  //       behaviour graded by 6c. Reading `tabIndex === 0` and calling it "tab
  //       order membership is the behaviour" was grading an internal symptom
  //       and dressing it up — corrected below, and 6i-f now pins the Tab
  //       constraint down so the file states it rather than implying otherwise.
  //
  //       What it does buy is focus at all. ARIA only honours
  //       `aria-activedescendant` on an element that can hold DOM focus, and
  //       `.cue-list` is `overflow: auto` — which makes it focusable in
  //       Chromium only while it actually has scrollable overflow, i.e. only
  //       while the show is long enough. A two-cue show has none, and without
  //       `tabIndex` the whole widget goes inert with no visible change. So the
  //       probe suppresses the overflow and asks whether the element is
  //       focusable for a reason that survives a short show.
  //
  //       That distinction is not academic: the first version of this check
  //       read plain `.focus()` success, and deleting `tabIndex` left all 103
  //       checks green, because the scrollbar was doing the work.
  const readListbox = `(() => {
    const list = document.querySelector('.cue-list')
    if (list === null) throw new Error('no cue list')
    const inlineOverflow = list.style.overflow
    list.style.overflow = 'visible'
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    list.focus()
    const focusableWithoutScroll = document.activeElement === list
    list.style.overflow = inlineOverflow
    list.focus()
    const rows = [...document.querySelectorAll('.cue-row')]
    const active = list.getAttribute('aria-activedescendant')
    const target = active === null ? null : document.getElementById(active)
    return {
      role: list.getAttribute('role'),
      focusableWithoutScroll,
      tabIndex: list.tabIndex,
      focusable: document.activeElement === list,
      active,
      activeRole: target === null ? null : target.getAttribute('role'),
      activeSelected: target === null ? null : target.getAttribute('aria-selected'),
      activeIndex: target === null ? -1 : rows.indexOf(target),
      barIndex: rows.findIndex((row) => row.classList.contains('is-selected')),
      options: rows.filter((row) => row.getAttribute('role') === 'option').length,
      rows: rows.length,
    }
  })()`
  const listbox = await page.evaluate(readListbox)
  check(listbox.role === 'listbox' && listbox.focusableWithoutScroll && listbox.focusable
      && listbox.options === listbox.rows
      && listbox.activeRole === 'option' && listbox.activeSelected === 'true'
      && listbox.activeIndex >= 0 && listbox.activeIndex === listbox.barIndex,
    'the cue listbox takes focus and names the selected row as its active option',
    `${JSON.stringify(listbox)}`)

  // And it tracks: an ArrowDown moves the accent bar and the active option
  // together. A one-shot read would pass against an activedescendant rendered
  // once and never updated, which is the failure an AT user actually hits.
  await pressKey(page, ARROW_DOWN)
  const listboxAfter = await page.evaluate(readListbox)
  check(listboxAfter.activeIndex === listboxAfter.barIndex
      && listboxAfter.activeIndex !== listbox.activeIndex
      && listboxAfter.activeSelected === 'true',
    'the active option follows the selection when it moves',
    `active ${listbox.activeIndex} -> ${listboxAfter.activeIndex}, ` +
    `bar ${listboxAfter.barIndex}, aria-selected ${listboxAfter.activeSelected}`)
  // 6i-f. Tab does not move focus anywhere on this surface — it toggles
  //       Live/Preview, unconditionally, for every target that is not a text
  //       input (`PlayScreen.tsx:353`). Recorded as a check rather than left
  //       as a comment because 6i-e's `tabIndex` reads as a promise of
  //       sequential navigation to anyone who does not know this, and a stated
  //       constraint with no instrument behind it is the thing that goes stale
  //       and then misleads. If someone later stops swallowing Tab, this goes
  //       red and 6i-e's reasoning gets re-read, which is the point.
  const focusBeforeTab = await page.evaluate(
    `(() => { document.querySelector('.cue-list').focus()
      return document.activeElement.className })()`)
  const modeBeforeTabKey = await page.evaluate('document.querySelector(".player-shell")?.className ?? ""')
  await pressKey(page, TAB)
  const afterTabKey = await page.evaluate(`(() => ({
    focus: document.activeElement === null ? 'none' : document.activeElement.className,
    shell: document.querySelector('.player-shell')?.className ?? '',
  }))()`)
  await pressKey(page, TAB)
  const modeRestored = await waitFor(
    'document.querySelector(".player-shell")?.className.includes("mode-live") ? "live" : null')
  check(afterTabKey.focus === focusBeforeTab && afterTabKey.shell !== modeBeforeTabKey
      && modeRestored === 'live',
    'Tab toggles the mode instead of moving focus, so tab order reaches nothing here',
    `focus "${focusBeforeTab}" -> "${afterTabKey.focus}" · shell ${modeBeforeTabKey} -> ` +
    `${afterTabKey.shell} · restored ${modeRestored}`)
  await page.evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()')

  // 5. Quitting leaves the floor black. Controllers 2 and 3 hold their last
  //    frame indefinitely, so the last frame sent is the one that stays lit.
  const beforeQuit = tap.packets.length
  electron.kill('SIGTERM')
  await sleep(2_500)
  const tail = tap.packets.slice(beforeQuit).slice(-20)
  check(tail.length > 0 && allBlack(tail), 'the last frame sent before quit is black',
    `${tail.length} trailing packets`)

  // 6. The log this run wrote, graded as the instrument it is.
  //
  //    Placed here deliberately: after the quit, so the record is complete, and
  //    BEFORE `checkLibrarySurvivesRestart` relaunches Electron — that
  //    relaunch rotates `ddf.log` to `ddf.prev.log`, and reading afterwards
  //    would grade a two-line file from a different run while looking exactly
  //    like a pass.
  //
  //    `~/Library/Logs/<app name>` is not the `--user-data-dir` this run set:
  //    on macOS Electron derives the log folder from the app name, not from
  //    the profile. Unpackaged, that name is "Electron".
  const logPath = join(homedir(), 'Library', 'Logs', 'Electron', 'ddf.log')
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const logRecords = logText.split('\n').filter((line) => /^\d{4}-/.test(line))

  // Assert the count as well as the content. `includes` on an empty string is
  // false, so a missing file would fail the checks below anyway — but it would
  // fail them as four unrelated content problems rather than as "there is no
  // log", and this project has been sent down that road before.
  check(logRecords.length > 10, 'the run left a log with records in it',
    `${logRecords.length} records at ${logPath}`)

  check(logText.includes('  INFO   launch  ') && logText.includes('packaged=false'),
    'the log opens with the launch block that identifies the build',
    logRecords[0] ?? '(no records)')

  check(logText.includes('spawning: ') && logText.includes('-m mapper stream'),
    'the log records the sender argv, not just that a sender started')

  // The one that silently did not work when this was first written. Python
  // block-buffers stdout into a pipe, so `mapper`'s own account of the address
  // and NIC it bound to sat unflushed in the child for the life of the process
  // — a capture that looked like it worked and recorded nothing. Only a check
  // that reads the file after a real run can see that.
  check(logText.includes('stdout: sending to '),
    "the log captures the sender's own statement of what it bound to",
    logText.split('\n').find((line) => line.includes('stdout: sending to ')) ?? '(absent)')

  // The cry-wolf check, and the reason it belongs in this file rather than in a
  // unit test. `frameWatch.test.ts` grades the verdict function against
  // hand-built states; this grades the whole watchdog against a real renderer
  // that ran a real show for the length of this gate. A watchdog that fires
  // during a healthy run is worse than no watchdog, and nothing but a live run
  // can find that.
  check(!logText.includes('stopped producing frames') && !logText.includes('never produced a frame'),
    'the renderer watchdog stayed quiet through a healthy run',
    logText.split('\n').filter((line) => line.includes('producing frame')).join(' | '))

  // 6a. The failing clip's path.
  //
  //     The banner sentence and the log line used to be the same string, so the
  //     log inherited a constraint that belongs only to a UI element an
  //     operator reads over a console mid-show. The consequence is on record:
  //     the 2026-09-05/06 job wrote 116 `ERROR player` lines naming cues and
  //     no paths, while every `INFO player live:` line beside them — the ones
  //     nobody needed to chase — carried a full path.
  //
  //     Graded here rather than only in `engine.test.ts` because the unit test
  //     can only prove the string exists; this proves it survives the trip
  //     through `App.tsx`'s effect, the IPC, and `log.ts` into the file an
  //     operator actually hands over. The cue is the `rawvideo.avi` fixture,
  //     fired from idle back in section 2a.
  const playerErrors = logText.split('\n').filter((line) => line.includes('  ERROR  player  '))
  check(playerErrors.length > 0 && playerErrors.some((line) => line.includes(undecodable)),
    'the log names the file behind a cue that would not play, not only the cue',
    `${playerErrors.length} player errors · ${playerErrors[0] ?? '(none)'}`)

  // 6b. The heartbeat's renderer field.
  //
  //     Three assertions in a fixed order, because they fail differently. That
  //     there are heartbeats at all is the positive control: without it the two
  //     below would both pass on an empty file by finding nothing to disagree
  //     with, which is this project's own signature failure with the instrument
  //     as the subject.
  const heartbeats = logText.split('\n').filter((line) => line.includes('  INFO   heartbeat  '))
  check(heartbeats.length > 0, 'the run left heartbeats to read',
    `${heartbeats.length} heartbeats · ${heartbeats[heartbeats.length - 1] ?? '(none)'}`)

  //     A heartbeat that reported the renderer live *and* saw it compose
  //     something. An idle renderer is healthy and prints `composes=0
  //     draw=-/-ms`, which is correct and useless for grading the numbers, so
  //     the line this reads is one from while the show was actually running.
  const composing = heartbeats.filter((line) => /renderer=live\b/.test(line)
    && /composes=[1-9]/.test(line))
  check(composing.length > 0,
    'a heartbeat catches the renderer live and composing, rather than silent',
    heartbeats.map((line) => line.slice(line.indexOf('renderer='))).join('\n          '))

  const lastComposing = composing[composing.length - 1] ?? ''
  const field = (name) => new RegExp(`\\b${name}=(\\S+)`).exec(lastComposing)?.[1] ?? null
  const readback = field('readback')
  //     `avg/max` in milliseconds, and the assertion is on the shape rather
  //     than on a bound. A threshold here would be a performance target this
  //     gate has no business enforcing on whatever machine it runs on; what it
  //     is entitled to insist on is that the cost was measured and written
  //     down, in a form the next investigation can read.
  check(readback !== null && /^\d+\.\d\d\/\d+\.\d\dms$/.test(readback),
    'the heartbeat carries the canvas readback cost, the span that used to be charged to nothing',
    `readback=${readback} · draw=${field('draw')} · pass=${field('pass')}`)

  const decoders = Number(field('decoders'))
  const opened = Number(field('opened'))
  const peak = Number(field('peak'))
  //     The census, and the half of it that can be wrong in the reassuring
  //     direction. This run adds seven cues, each of which opens a throwaway
  //     thumbnail decoder and a throwaway duration probe, on top of the three
  //     slots the engine holds — so `opened` has to be well into double
  //     figures, and `decoders` has to be back down among the slots. A census
  //     that only counted up would satisfy the first and fail the second,
  //     which is the point of asserting both: it would otherwise sit there
  //     climbing, and eventually report an exhaustion that never happened.
  check(Number.isFinite(opened) && opened >= 10 && Number.isFinite(peak) && peak >= 2,
    'the heartbeat carries the decoder census, and the run really did open decoders',
    `decoders=${decoders} peak=${peak} opened=${opened}`)
  check(Number.isFinite(decoders) && Number.isFinite(opened) && opened >= 10 && decoders <= 5,
    'the decoder count comes back down — the census releases, it does not only count up',
    `decoders=${decoders} of ${opened} opened, peak ${peak}`)

  // 7. The reauthorisation policy, proved rather than only documented — see
  //    `checkLibrarySurvivesRestart`. Run after the main run's Electron has
  //    quit and before the workspace it wrote `settings.json` into is
  //    removed in the `finally` block below.
  await checkLibrarySurvivesRestart(workspace, sibling.split('/').pop())
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
