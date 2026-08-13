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
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** `mapper`'s packet header. Five bytes, not eight — see `docs/PROTOCOL.md`. */
const HEADER_LEN = 5
const PORT = 60_001
const DEBUG_PORT = 9_333
const APP_DIR = resolve(import.meta.dirname, '..', '..')

const failures = []
let stepNumber = 0

function check(ok, description, detail = '') {
  stepNumber += 1
  const line = `${ok ? 'PASS' : 'FAIL'}  ${String(stepNumber).padStart(2, ' ')}. ${description}`
  console.log(detail === '' ? line : `${line}\n          ${detail}`)
  if (!ok) failures.push(description)
}

// --------------------------------------------------------------- test clips

function makeClip(directory, colour) {
  const path = join(directory, `${colour}.mp4`)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=640x480:r=30:d=3`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
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
    this.socket = createSocket('udp4')
    this.socket.on('message', (message) => this.packets.push(message))
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

  close() {
    this.socket.close()
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
            throw new Error(`page threw: ${reply.result.exceptionDetails.text}`)
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
 * Type a duration into the inspector, the way the operator does.
 *
 * The value goes through the property setter on the prototype rather than
 * `input.value = x`. React installs its own setter on the element instance and
 * tracks the last value it saw, so a direct assignment updates the DOM, is
 * recorded as "already seen", and the `input` event that follows is discarded
 * as a no-op change. The field would show the number and the cue would never
 * get it — a test that drives the UI and grades nothing.
 */
const typeDurationScript = (seconds) => `(() => {
  const input = document.querySelector('[aria-label="Cue duration in seconds"]')
  if (input === null) throw new Error('no duration field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(String(seconds))})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`

// -------------------------------------------------------------------- main

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
        DDF_PICK_MEDIA: [...clips, undecodable].join(delimiter),
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

  // 2. A cue reaches the wire. This is also the only place the readiness path
  //    is exercised for real: the video elements are detached from the
  //    document, and if `ready` never flipped, GO would silently do nothing.
  await page.evaluate(clickScript('[aria-label="Add cue"]'))
  // Polled, not slept. The picker is an IPC round trip and the rows are a React
  // render behind it, and a fixed wait that is long enough on a warm machine
  // reads zero cues on a cold one — grading a healthy app red. This file argues
  // for polling twice in its own comments and then did this.
  const cueCount = await waitFor(
    'document.querySelectorAll(".cue-row").length === 3 ? 3 : 0')
  check(cueCount === 3, 'all three seeded cues land in the stack',
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

  // 3b. A timed cue advances on its own, and the edit reaches a cue that is
  //     already playing.
  //
  //     The order is the point. Cue 1 is put live *first* and given a duration
  //     *after*, because a slot captures its `Cue` at arm time — so setting the
  //     length beforehand would grade nothing but `advanceOnDuration`, and the
  //     defect this is here for is that a live slot went on reading the length
  //     the cue had when GO was pressed. Set it while live, and the only way
  //     the advance happens is if `setShow` reseated the slot.
  //
  //     It also grades the inspector control itself, through the real field.
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  const liveForTiming = await waitForLive(0)
  check(liveForTiming === 0, 'cue 1 is live before its length is edited',
    `live row index ${liveForTiming}`)

  await page.evaluate(clickRowScript(0))
  await page.evaluate(clickButtonScript('Set'))
  const fieldExists = await waitFor(
    'document.querySelector(\'[aria-label="Cue duration in seconds"]\') !== null')
  check(fieldExists === true, 'the duration field appears when the cue stops holding')
  const typed = await page.evaluate(typeDurationScript(3))
  check(typed === '3', 'the duration field takes the value typed into it', String(typed))

  // Selecting a cue is also how Standby is armed, so editing the live cue in
  // the inspector left Standby pointing at the live cue — and a timed advance
  // fires Standby, which would have restarted cue 1 rather than moving on.
  // That is the engine's stated rule (Standby is what fires next, however it
  // fires), not a defect, but it means this has to put Standby back on cue 2
  // the way an operator would before the length elapses.
  await page.evaluate(clickRowScript(1))

  const fromAdvance = tap.packets.length
  // No further input from here. If the next line passes, the engine advanced on
  // its own, on a length that was edited under a running cue.
  const advancedTo = await waitForLive(1)
  check(advancedTo === 1, 'the timed cue advanced to the next cue with no GO',
    `live row index ${advancedTo}`)

  const acrossAdvance = tap.packets.slice(fromAdvance)
  check(acrossAdvance.length > 0 && countTone(acrossAdvance, 'black') === 0,
    'no black frame appears across the automatic advance',
    `${countTone(acrossAdvance, 'black')} of ${acrossAdvance.length} packets were all-zero`)

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
}

console.log(failures.length === 0
  ? `\nAll ${stepNumber} wire checks passed.`
  : `\n${failures.length} of ${stepNumber} wire checks FAILED:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
