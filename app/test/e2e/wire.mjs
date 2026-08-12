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
    let nextId = 0

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      waiter(message)
    })
    socket.addEventListener('error', rejectPage)
    socket.addEventListener('open', () => {
      resolvePage({
        /** Evaluate an expression in the page and return its JSON value. */
        async evaluate(expression) {
          const id = (nextId += 1)
          const reply = await new Promise((settle) => {
            pending.set(id, settle)
            socket.send(JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true },
            }))
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

// -------------------------------------------------------------------- main

const workspace = mkdtempSync(join(tmpdir(), 'ddf-e2e-'))
const tap = new WireTap()
let electron = null
let page = null

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) {
    throw new Error('dist/main.js is missing — run `npm run build` first')
  }

  const clips = [makeClip(workspace, 'red'), makeClip(workspace, 'white')]
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
        DDF_PICK_MEDIA: clips.join(delimiter),
      },
      stdio: 'inherit',
    },
  )

  page = await attachToPage()

  // 1. The sidecar is up and sending before anything has been asked of it.
  const idle = await tap.window(1_000)
  check(idle.length > 0, 'the sidecar sends while the player is idle',
    `${idle.length} packets in 1 s (expect ~600/s at 30 fps x 20 packets)`)
  check(allBlack(idle), 'idle is black frames, not silence')

  // 2. A cue reaches the wire. This is also the only place the readiness path
  //    is exercised for real: the video elements are detached from the
  //    document, and if `ready` never flipped, GO would silently do nothing.
  await page.evaluate(clickScript('[aria-label="Add cue"]'))
  await sleep(400)
  const cueCount = await page.evaluate('document.querySelectorAll(".cue-row").length')
  check(cueCount === 2, 'both seeded cues land in the stack', `saw ${cueCount}`)

  await page.evaluate(clickButtonScript('GO'))
  let lit = []
  for (let attempt = 0; attempt < 25 && !anyLit(lit); attempt++) lit = await tap.window(200)
  check(anyLit(lit), 'GO puts a decoded frame on the wire')
  check(countTone(lit, 'red') > 0, 'the frame on the wire is the first cue',
    `red ${countTone(lit, 'red')} · white ${countTone(lit, 'white')} · black ${countTone(lit, 'black')}`)

  // 3. A cue change. The first two checks establish that the change actually
  //    happened — without them, a second cue that never decodes leaves the
  //    first on the wire and "no black appeared" grades nothing at all. Only
  //    then does the third check mean something, and even then it is strictly
  //    one-sided: it catches a gap, and cannot prove the absence of a stall,
  //    because `Sidecar` re-sends. `engine.test.ts` owns that half.
  const liveIndex = '[...document.querySelectorAll(".cue-row")]' +
    '.findIndex((row) => row.classList.contains("is-live"))'
  check(await page.evaluate(liveIndex) === 0, 'cue 1 is the live cue before the change')

  const fromChange = tap.packets.length
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cue-row')]
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)

  let movedTo = -1
  for (let attempt = 0; attempt < 25 && movedTo !== 1; attempt++) {
    await sleep(200)
    movedTo = await page.evaluate(liveIndex)
  }
  check(movedTo === 1, 'the second cue actually became live', `live row index ${movedTo}`)

  const across = tap.packets.slice(fromChange)
  check(countTone(across, 'red') > 0 && countTone(across, 'white') > 0,
    'both cues are visible on the wire across the change',
    `red ${countTone(across, 'red')} · white ${countTone(across, 'white')}`)
  check(countTone(across, 'black') === 0, 'no black frame appears across the cue change',
    `${countTone(across, 'black')} of ${across.length} packets were all-zero`)

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
  page?.close()
  if (electron !== null && electron.exitCode === null) electron.kill('SIGKILL')
  tap.close()
  rmSync(workspace, { recursive: true, force: true })
}

console.log(failures.length === 0
  ? `\nAll ${stepNumber} wire checks passed.`
  : `\n${failures.length} of ${stepNumber} wire checks FAILED:\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
