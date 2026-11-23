/**
 * A show, replayed: does this tree put the intended cue on the floor, without
 * unplanned black and without freezing, for as long as a show runs?
 *
 * **A measurement, not a gate.** Nothing runs it automatically. It exists to
 * compare two trees under the same load — stock `main` against
 * `app-decode-recovery` — before the second goes to a floor:
 *
 *     npm run build && node test/e2e/probe-show-soak.mjs            # one arm
 *     SOAK_SECONDS=1800 SEED=7 node test/e2e/probe-show-soak.mjs     # longer
 *     node test/e2e/probe-show-soak.mjs --compare main.json branch.json
 *
 * Each run is one arm: the tree it is run from. It writes its result to
 * `SOAK_OUT` (default: a JSON file in the system temp folder, named in the
 * output) together with a copy of the run's `pxdf.log`, and `--compare` reads
 * two of them. `SOAK_FAULT='{"match":"soak-cue1","afterMs":2000,"mode":"once"}'`
 * adds a decode fault through the seam, for showing what each arm does with one.
 *
 * ## The instrument
 *
 * Every fixture clip carries two numbers in its picture, as whole black/white
 * tiles at the 8 x 8 floor's tile size: its **cue id** (3 bits) and its
 * **source frame index** (12 bits), each bit beside its complement, plus a
 * white and a black marker tile. This script reads UDP off 127.0.0.1,
 * reassembles each wire frame by its headers, un-maps it with `mapper`'s own
 * `send_buffer_sources`, and reads both numbers back. So every frame on the
 * wire says which cue it came from and whether the clip moved since the last
 * one, which is what the three consequences below need:
 *
 *  - **Wrong or late cue.** Every GO names a cue. The first wire frame carrying
 *    that cue id must arrive within `PROMOTE_MS`, and nothing but the outgoing
 *    cue may appear before it.
 *  - **Unplanned black.** An all-zero payload outside a planned BLACKOUT.
 *  - **Freeze.** One (cue, index) on the wire for longer than `FREEZE_MS`
 *    outside a planned PAUSE.
 *
 * The trace is seeded (`SEED`), so two arms replay the same show. It drives
 * the operator's path: select a row (Standby), then GO; BLACKOUT on and off;
 * PAUSE and RESUME. It opens with two fixed segments for the draw-cost gate:
 * 20 s of the 2160 x 2160 clip, then 20 s of a 768 x 768 one.
 *
 * ## Positive controls — a failure in any one means the instrument is broken
 *
 * No result is written, the reasons are printed, and the exit is 2.
 *
 *  0a. Every frame of every fixture, decoded back by ffmpeg, reads as its own
 *      cue and index. (The fixtures say what they claim to.)
 *  0b. A known frame packetised by `mapper`'s own `build_frame` reassembles and
 *      decodes here. (The wire decoder is not guessing at the mapping.)
 *  1.  Every heartbeat in the soak reads `floor=8x8_4P 8x8`, and there is at
 *      least one.
 *  2.  >= 99 % of wire frames reassemble completely.
 *  3.  **The black detector sees planned black**: every planned BLACKOUT
 *      window holds black wire frames.
 *  4.  **The freeze detector sees a planned freeze**: every planned PAUSE
 *      window holds a run of one (cue, index) longer than `FREEZE_MS`.
 *  5.  **Motion and cue changes are real**: the clip index advances on at
 *      least 10 % of steps, and at least three distinct cue ids reach it.
 *      How often it advances is a result (`moving`), not a control.
 *  6.  The page raised no uncaught exception, and no Electron survived.
 *
 * Without 3 and 4, "zero unplanned black" and "zero freezes" would be
 * indistinguishable from detectors that cannot see either.
 *
 * ## What it cannot see
 *
 * A real `PIPELINE_ERROR_DECODE`. That has no recipe, and a soak over files
 * that decode cleanly will not raise one on demand — `wire.mjs`'s
 * `checkDecodeFault` grades recovery through the seam instead. What this
 * grades is that the recovery tree costs nothing on a night with no decode
 * errors: same promotions, no new black, no new freezes, and draw cost on the
 * 2160 x 2160 clip — where `captureSnapshot`'s second `drawImage` per frame
 * would show — within `DRAW_TOLERANCE` of the other arm.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DEBUG_PORT = 9_341
const SIDECAR_PORT = 60_006
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const REPO_ROOT = resolve(APP_DIR, '..')
const PYTHON = process.env.PXDF_PYTHON ?? 'python3'
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'Electron', 'pxdf.log')

const FLOOR = { type: '8x8_4P', cols: 8, rows: 8 }
const TILE = 8
const WIDTH_PX = FLOOR.cols * TILE
const HEIGHT_PX = FLOOR.rows * TILE
/** The pattern is authored at this tile size, then scaled to each clip's size. */
const SRC_TILE = 16
const SRC_PX = FLOOR.cols * SRC_TILE

const SOAK_SECONDS = Number(process.env.SOAK_SECONDS ?? '300')
const SEED = Number(process.env.SEED ?? '1')
const CLIP_SECONDS = 10
const CLIP_FPS = 30
const HEARTBEAT_SECONDS = 5
/** A GO's cue must be on the wire by then. */
const PROMOTE_MS = 2_000
/** One (cue, index) for longer than this is a freeze. Fifteen frames at 30 fps. */
const FREEZE_MS = 500
/** Slack after a planned BLACKOUT or PAUSE ends, before black or a freeze counts. */
const PLANNED_SLACK_MS = 700
/** `--compare`: the second arm's draw cost on the heavy clip may exceed the first's by this much. */
const DRAW_TOLERANCE = { ratio: 1.15, ms: 1 }
/** `--compare`: the second arm's share of moving steps may be this many points lower. */
const MOVING_TOLERANCE = 5

/**
 * The cues. Cue id is what the picture carries, so it is also the row order the
 * picker seeds them in. `heavy` is the draw-cost clip: the size the still-image
 * conversions were on the night they cost about 50 ms a frame.
 */
const CUES = [
  { id: 0, size: 768, codec: 'h264' },
  { id: 1, size: 768, codec: 'h264' },
  { id: 2, size: 640, codec: 'h264' },
  { id: 3, size: 768, codec: 'hevc' },
  { id: 4, size: 1080, codec: 'h264' },
  { id: 5, size: 2160, codec: 'h264', heavy: true },
]
const HEAVY = CUES.find((cue) => cue.heavy).id
const BASELINE = 0

// ------------------------------------------------------------- the code tiles

const INDEX_BITS = 12
const CUE_BITS = 3
const BITS = INDEX_BITS + CUE_BITS
/** Bit b sits at column b % 8 of row 2 * floor(b / 8), its complement one row below. */
const bitTile = (b) => [b % 8, 2 * Math.floor(b / 8)]
const complementTile = (b) => [b % 8, 2 * Math.floor(b / 8) + 1]
const WHITE_MARK = [7, 2]
const BLACK_MARK = [7, 3]

function drawPattern(cue, index, tilePx) {
  const side = FLOOR.cols * tilePx
  const image = new Uint8Array(side * side)
  const fill = ([col, row], value) => {
    for (let y = row * tilePx; y < (row + 1) * tilePx; y++) {
      image.fill(value, y * side + col * tilePx, y * side + (col + 1) * tilePx)
    }
  }
  const word = index | (cue << INDEX_BITS)
  for (let b = 0; b < BITS; b++) {
    const bit = (word >> b) & 1
    fill(bitTile(b), bit ? 255 : 0)
    fill(complementTile(b), bit ? 0 : 255)
  }
  fill(WHITE_MARK, 255)
  return image
}

/** `{ cue, index }` from a 64 x 64 RGB framebuffer, or `null` if any tile is undecided. */
function decodeWord(rgb) {
  const level = ([col, row]) => {
    let sum = 0
    for (let y = row * TILE + 2; y < row * TILE + 6; y++) {
      for (let x = col * TILE + 2; x < col * TILE + 6; x++) {
        const p = (y * WIDTH_PX + x) * 3
        sum += rgb[p] + rgb[p + 1] + rgb[p + 2]
      }
    }
    const value = sum / 48
    return value > 192 ? 1 : value < 64 ? 0 : null
  }
  if (level(WHITE_MARK) !== 1 || level(BLACK_MARK) !== 0) return null
  let word = 0
  for (let b = 0; b < BITS; b++) {
    const bit = level(bitTile(b))
    const complement = level(complementTile(b))
    if (bit === null || complement === null || bit === complement) return null
    word |= bit << b
  }
  return { cue: word >> INDEX_BITS, index: word & ((1 << INDEX_BITS) - 1) }
}

// ------------------------------------------------------------------ fixtures

function makeClip(directory, cue) {
  const frames = CLIP_SECONDS * CLIP_FPS
  const raw = Buffer.alloc(frames * SRC_PX * SRC_PX)
  for (let i = 0; i < frames; i++) raw.set(drawPattern(cue.id, i, SRC_TILE), i * SRC_PX * SRC_PX)
  const path = join(directory, `soak-cue${cue.id}-${cue.size}-${cue.codec}.mp4`)
  const codec = cue.codec === 'hevc'
    ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-crf', '14']
    : ['-c:v', 'libx264', '-crf', '14']
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SRC_PX}x${SRC_PX}`, '-r', String(CLIP_FPS), '-i', '-',
    '-vf', `scale=${cue.size}:${cue.size}:flags=neighbor`,
    ...codec, '-pix_fmt', 'yuv420p', '-g', String(CLIP_FPS), '-movflags', '+faststart', path,
  ], { input: raw, maxBuffer: 1 << 26 })
  return { ...cue, path, frames }
}

/** Control 0a. */
function checkClip(clip) {
  const out = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', clip.path,
    '-fps_mode', 'passthrough', '-vf', `scale=${WIDTH_PX}:${HEIGHT_PX}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 28 })
  const frameBytes = WIDTH_PX * HEIGHT_PX * 3
  const decoded = out.length / frameBytes
  let wrong = 0
  for (let i = 0; i < decoded; i++) {
    const word = decodeWord(out.subarray(i * frameBytes, (i + 1) * frameBytes))
    if (word === null || word.cue !== clip.id || word.index !== i) wrong += 1
  }
  return decoded === clip.frames && wrong === 0
    ? null
    : `${clip.path} decodes to ${decoded} frames (want ${clip.frames}), ${wrong} not reading as cue ${clip.id} and their own index`
}

/** Control 0b: the floor's layout from `mapper`, and a known frame through its packetiser. */
function mapperLayout() {
  const grey = drawPattern(HEAVY, 1234, TILE)
  const rgb = Buffer.alloc(grey.length * 3)
  for (let i = 0; i < grey.length; i++) rgb.fill(grey[i], i * 3, i * 3 + 3)
  const script = `
import base64, json, sys
from mapper.floors import FloorConfig, BODY_MAX
from mapper.frame import build_frame, send_buffer_sources
c = FloorConfig.of(${JSON.stringify(FLOOR.type)}, ${FLOOR.cols}, ${FLOOR.rows})
fb = sys.stdin.buffer.read()
print(json.dumps({
  'widthPx': c.width_px, 'heightPx': c.height_px,
  'portDataSize': c.port_data_size, 'portsPerController': c.type.ports_per_controller,
  'controllers': c.controller_count, 'packetsPerFrame': c.packets_per_frame,
  'bytesPerFrame': c.bytes_per_frame, 'bodyMax': BODY_MAX,
  'sources': list(send_buffer_sources(c)),
  'known': [base64.b64encode(d).decode() for d in build_frame(c, fb)],
}))
`
  const layout = JSON.parse(execFileSync(PYTHON, ['-c', script], { cwd: REPO_ROOT, input: rgb, encoding: 'utf8', maxBuffer: 1 << 24 }))
  layout.known = layout.known.map((b64) => Buffer.from(b64, 'base64'))
  return layout
}

// ------------------------------------------------------------ wire reassembly

const HEADER_LEN = 5
const isEndOfFrame = (packet) => (packet[4] & 0x80) !== 0

/** `{ t, complete, black, cue, index }` per wire frame; the partial frame before the first end is dropped. */
function assembleFrames(packets, times, layout) {
  const lastController = layout.controllers - 1
  const frames = []
  let started = false
  let current = []
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]
    const ends = isEndOfFrame(packet) && packet[1] === lastController
    if (!started) {
      if (ends) started = true
      continue
    }
    current.push(packet)
    if (ends) {
      frames.push({ t: times[i], ...decodeWireFrame(current, layout) })
      current = []
    }
  }
  return frames
}

function decodeWireFrame(packets, layout) {
  const none = { complete: false, black: false, cue: null, index: null }
  if (packets.length !== layout.packetsPerFrame) return none
  const payloadBytes = layout.widthPx * layout.heightPx * 3
  const buffer = Buffer.alloc(payloadBytes)
  const seen = new Set()
  let bytes = 0
  for (const packet of packets) {
    const key = `${packet[1]}/${packet[3]}/${packet[4] & 0x7f}`
    if (seen.has(key)) return none
    seen.add(key)
    const tileCol = layout.portsPerController * packet[1] + packet[3]
    const start = tileCol * layout.portDataSize + (packet[4] & 0x7f) * layout.bodyMax
    const body = packet.subarray(HEADER_LEN)
    body.copy(buffer, start)
    bytes += body.length
  }
  if (bytes !== payloadBytes) return none
  if (buffer.every((b) => b === 0)) return { complete: true, black: true, cue: null, index: null }
  const rgb = Buffer.alloc(payloadBytes)
  layout.sources.forEach((source, slot) => {
    rgb[source * 3] = buffer[slot * 3 + 2]
    rgb[source * 3 + 1] = buffer[slot * 3 + 1]
    rgb[source * 3 + 2] = buffer[slot * 3]
  })
  const word = decodeWord(rgb)
  return { complete: true, black: false, cue: word?.cue ?? null, index: word?.index ?? null }
}

class WireTap {
  constructor() {
    this.packets = []
    this.times = []
    this.socket = createSocket('udp4')
    this.socket.on('message', (message) => {
      this.packets.push(message)
      this.times.push(Date.now())
    })
  }

  listen() {
    return new Promise((done) => this.socket.bind(SIDECAR_PORT, '127.0.0.1', () => {
      try { this.socket.setRecvBufferSize(8 << 20) } catch { /* the default still holds several frames */ }
      done()
    }))
  }

  reset() {
    this.packets = []
    this.times = []
  }

  close() {
    this.socket.close()
  }
}

// ------------------------------------------------------------------ the trace

/** mulberry32: small, seeded, and the same in every arm. */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `[{ at, kind, cue?, holdMs? }]`, offsets in ms from the soak's start. Opens
 * with the two fixed draw-cost segments, then random GOs, BLACKOUTs and PAUSEs
 * until `SOAK_SECONDS`.
 */
function buildTrace(seed, seconds) {
  const random = prng(seed)
  const trace = [
    { at: 0, kind: 'go', cue: HEAVY, segment: 'heavy' },
    { at: 20_000, kind: 'go', cue: BASELINE, segment: 'baseline' },
  ]
  let at = 40_000
  let current = BASELINE
  while (at < seconds * 1_000) {
    const roll = random()
    if (roll < 0.12) {
      trace.push({ at, kind: 'blackout', holdMs: 2_500 })
      at += 2_500 + 2_000
    } else if (roll < 0.24) {
      trace.push({ at, kind: 'pause', holdMs: 2_500 })
      at += 2_500 + 2_000
    } else {
      let cue = current
      while (cue === current) cue = Math.floor(random() * CUES.length)
      current = cue
      trace.push({ at, kind: 'go', cue })
      at += 3_000 + Math.floor(random() * 6_000)
    }
  }
  return { trace, endMs: at }
}

// ------------------------------------------------------ DevTools protocol

async function attachToPage() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const page = (await response.json()).find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return await open(page.webSocketDebuggerUrl)
    } catch {
      // The port is not up yet.
    }
    await sleep(200)
  }
  throw new Error('Electron never exposed a debuggable page')
}

/** `wire.mjs`'s `open`, cut down: evaluate, and the uncaught-exception channel. */
function open(url) {
  return new Promise((resolvePage, rejectPage) => {
    const socket = new WebSocket(url)
    const pending = new Map()
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
        exceptions.set(text, { text, count: (exceptions.get(text)?.count ?? 0) + 1 })
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
        async evaluate(expression) {
          const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
          if (reply.result?.exceptionDetails !== undefined) {
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

const clickButtonScript = (text) => `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (button === undefined) throw new Error('no button labelled ${text}')
  button.click()
  return true
})()`

const selectScript = (label, value) => `(() => {
  const select = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})
  if (select === null) throw new Error('no select labelled ${label}')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, ${JSON.stringify(String(value))})
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return select.value
})()`

// ------------------------------------------------------------------- grading

/**
 * The trace, applied to the wire frames it produced. `actions` carry the wall
 * clock each was actually performed at, which is what the frames are stamped
 * against, not the offset it was scheduled for.
 */
function grade(frames, actions, soakEnd) {
  const planned = { black: [], freeze: [] }
  for (const action of actions) {
    if (action.kind === 'blackout') planned.black.push([action.t, action.tOff + PLANNED_SLACK_MS])
    if (action.kind === 'pause') planned.freeze.push([action.t, action.tOff + PLANNED_SLACK_MS])
  }
  const inside = (windows, t) => windows.some(([from, to]) => t >= from && t <= to)
  // From the first lit frame after the first GO: before it the floor is idle,
  // and idle is black by design. The first GO's own latency is still graded
  // below, from the GO.
  const firstGo = actions.find((a) => a.kind === 'go')?.t ?? Infinity
  const firstLit = frames.find((f) => f.t >= firstGo && f.complete && !f.black)?.t ?? Infinity
  const graded = frames.filter((f) => f.t >= firstLit && f.t <= soakEnd)
  const fromGo = frames.filter((f) => f.t >= firstGo && f.t <= soakEnd)

  // Promotions: the first frame carrying the GO's cue, and anything else before it.
  const gos = actions.filter((a) => a.kind === 'go')
  const promotions = gos.map((go, i) => {
    const until = gos[i + 1]?.t ?? soakEnd
    const window = fromGo.filter((f) => f.t >= go.t && f.t < until)
    const first = window.find((f) => f.cue === go.cue)
    const latencyMs = first === undefined ? null : first.t - go.t
    const before = first === undefined ? window : window.filter((f) => f.t < first.t)
    const after = first === undefined ? [] : window.filter((f) => f.t >= first.t)
    return {
      cue: go.cue,
      standby: go.standby,
      latencyMs,
      late: latencyMs === null || latencyMs > PROMOTE_MS,
      strayBefore: before.filter((f) => f.cue !== null && f.cue !== go.cue && f.cue !== go.outgoing).length,
      wrongAfter: after.filter((f) => f.cue !== null && f.cue !== go.cue).length,
    }
  })

  // Black and freeze runs, as events with a duration.
  const blackRuns = []
  const freezeRuns = []
  const plannedBlackSeen = planned.black.map(() => 0)
  const plannedFreezeLongest = planned.freeze.map(() => 0)
  let blackFrom = null
  let blackLast = null
  let run = null
  const closeBlack = () => {
    if (blackFrom !== null) blackRuns.push({ from: blackFrom, ms: blackLast - blackFrom })
    blackFrom = null
  }
  const closeRun = () => {
    if (run !== null && run.last - run.from > FREEZE_MS) {
      const window = planned.freeze.findIndex(([from, to]) => run.from >= from - 100 && run.last <= to)
      if (window === -1) freezeRuns.push({ from: run.from, ms: run.last - run.from, cue: run.cue, index: run.index })
    }
    if (run !== null) {
      planned.freeze.forEach(([from, to], i) => {
        const overlap = Math.min(run.last, to) - Math.max(run.from, from)
        if (overlap > plannedFreezeLongest[i]) plannedFreezeLongest[i] = overlap
      })
    }
    run = null
  }
  let undecoded = 0
  for (const frame of graded) {
    if (frame.black) {
      planned.black.forEach(([from, to], i) => { if (frame.t >= from && frame.t <= to) plannedBlackSeen[i] += 1 })
      closeRun()
      if (inside(planned.black, frame.t)) {
        closeBlack()
        continue
      }
      if (blackFrom === null) blackFrom = frame.t
      blackLast = frame.t
      continue
    }
    closeBlack()
    if (!frame.complete || frame.cue === null) {
      if (frame.complete) undecoded += 1
      continue
    }
    if (run !== null && run.cue === frame.cue && run.index === frame.index) {
      run.last = frame.t
    } else {
      closeRun()
      run = { cue: frame.cue, index: frame.index, from: frame.t, last: frame.t }
    }
  }
  closeBlack()
  closeRun()

  // Motion: the share of consecutive same-cue frames, outside PAUSE, whose index changed.
  let steps = 0
  let moved = 0
  for (let i = 1; i < graded.length; i++) {
    const a = graded[i - 1]
    const b = graded[i]
    if (a.cue === null || b.cue === null || a.cue !== b.cue || inside(planned.freeze, b.t)) continue
    steps += 1
    if (a.index !== b.index) moved += 1
  }

  return {
    frames: graded.length,
    complete: graded.filter((f) => f.complete).length,
    undecoded,
    distinctCues: new Set(graded.filter((f) => f.cue !== null).map((f) => f.cue)).size,
    moved: steps === 0 ? 0 : moved / steps,
    promotions,
    blackRuns,
    freezeRuns,
    plannedBlackSeen,
    plannedFreezeLongest,
  }
}

/** Heartbeat `draw` averages whose whole 5 s window sat inside a segment. */
function drawDuring(logText, from, to) {
  const values = []
  for (const line of logText.split('\n')) {
    if (!line.includes('  INFO   heartbeat  ')) continue
    const at = Date.parse(line.slice(0, 24))
    const draw = /\bdraw=([\d.]+)\/([\d.]+)ms/.exec(line)
    if (!Number.isFinite(at) || draw === null) continue
    if (at - HEARTBEAT_SECONDS * 1_000 >= from + 2_000 && at <= to) values.push(Number(draw[1]))
  }
  return values
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// ------------------------------------------------------------------ compare

function compare(aPath, bPath) {
  const a = JSON.parse(readFileSync(aPath, 'utf8'))
  const b = JSON.parse(readFileSync(bPath, 'utf8'))
  const rows = [
    ['arm', a.arm, b.arm],
    ['seed / soak s', `${a.seed} / ${a.soakSeconds}`, `${b.seed} / ${b.soakSeconds}`],
    ['injected fault', a.fault ?? 'none', b.fault ?? 'none'],
    ['GOs late or missed', a.summary.late, b.summary.late],
    ['GOs with a stray cue', a.summary.stray, b.summary.stray],
    ['frames of a wrong cue', a.summary.wrong, b.summary.wrong],
    ['unplanned black runs', a.summary.blackRuns, b.summary.blackRuns],
    ['unplanned black, longest ms', a.summary.blackLongestMs, b.summary.blackLongestMs],
    ['freezes > 500 ms', a.summary.freezes, b.summary.freezes],
    ['freeze, longest ms', a.summary.freezeLongestMs, b.summary.freezeLongestMs],
    ['undecoded frames', a.summary.undecoded, b.summary.undecoded],
    ['% of steps moving', a.summary.moving, b.summary.moving],
    ['draw ms, 2160² clip (median)', a.summary.drawHeavy, b.summary.drawHeavy],
    ['draw ms, 768² clip (median)', a.summary.drawBaseline, b.summary.drawBaseline],
  ]
  for (const [name, x, y] of rows) console.log(`${name.padEnd(32)} ${String(x).padStart(22)} ${String(y).padStart(22)}`)
  const worse = []
  if (a.seed !== b.seed) worse.push('the two arms replayed different seeds — not comparable')
  if (a.fault !== b.fault) worse.push(`the two arms ran different faults (${a.fault} vs ${b.fault}) — not comparable`)
  for (const key of ['late', 'stray', 'wrong', 'blackRuns', 'freezes']) {
    if (b.summary[key] > a.summary[key]) worse.push(`${key}: ${a.summary[key]} -> ${b.summary[key]}`)
  }
  if (b.summary.moving < a.summary.moving - MOVING_TOLERANCE) {
    worse.push(`moving ${a.summary.moving} % -> ${b.summary.moving} %, more than ${MOVING_TOLERANCE} points down`)
  }
  if (a.summary.drawHeavy !== null && b.summary.drawHeavy !== null
    && b.summary.drawHeavy > a.summary.drawHeavy * DRAW_TOLERANCE.ratio + DRAW_TOLERANCE.ms) {
    worse.push(`2160² draw ${a.summary.drawHeavy} -> ${b.summary.drawHeavy} ms, past ` +
      `x${DRAW_TOLERANCE.ratio} + ${DRAW_TOLERANCE.ms} ms`)
  }
  if (a.summary.drawHeavy === null || b.summary.drawHeavy === null) worse.push('a draw-cost reading is missing')
  console.log(worse.length === 0
    ? `\n${b.arm} is no worse than ${a.arm} on any graded consequence.`
    : `\n${b.arm} is WORSE than ${a.arm}:\n  - ${worse.join('\n  - ')}`)
  process.exit(worse.length === 0 ? 0 : 1)
}

// ---------------------------------------------------------------------- main

const compareAt = process.argv.indexOf('--compare')
if (compareAt !== -1) compare(process.argv[compareAt + 1], process.argv[compareAt + 2])

const refusals = []
const refuse = (why) => refusals.push(why)

const arm = (() => {
  const git = (...args) => execFileSync('git', args, { cwd: APP_DIR, encoding: 'utf8' }).trim()
  const dirty = git('status', '--porcelain', '--', '.', '../mapper').length > 0
  return `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('rev-parse', '--short', 'HEAD')}${dirty ? '-dirty' : ''}`
})()
const workspace = mkdtempSync(join(tmpdir(), 'pxdf-soak-'))
const outPath = process.env.SOAK_OUT ?? join(tmpdir(), `pxdf-soak-${arm.replace(/[^\w.-]+/g, '_')}-seed${SEED}.json`)
const tap = new WireTap()
let electron = null
let page = null
let exitCode = 0

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js is missing — run `npm run build` first')
  const squatter = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(() => true, () => false)
  if (squatter) throw new Error(`something is already listening on ${DEBUG_PORT} — a leaked Electron`)

  console.log(`arm ${arm} · seed ${SEED} · soak ${SOAK_SECONDS} s · fixtures in ${workspace}`)
  const clipDir = join(workspace, 'clips')
  mkdirSync(clipDir)
  const clips = CUES.map((cue) => makeClip(clipDir, cue))
  for (const clip of clips) {
    const problem = checkClip(clip)
    if (problem !== null) refuse(`0a. ${problem}`)
  }
  const layout = mapperLayout()
  const known = assembleFrames([layout.known[layout.known.length - 1], ...layout.known], [0, ...layout.known.map(() => 0)], layout)
  if (known.length !== 1 || known[0].cue !== HEAVY || known[0].index !== 1234) {
    refuse(`0b. mapper's own packetisation of cue ${HEAVY} frame 1234 reads back as ${JSON.stringify(known)}`)
  }
  if (refusals.length > 0) throw new Error('fixture controls failed')

  await tap.listen()
  await sleep(500)
  if (tap.packets.length > 0) throw new Error(`${tap.packets.length} packets arrived on ${SIDECAR_PORT} before this run started — something else is sending`)

  const env = {
    ...process.env,
    PXDF_ADDRESS: '127.0.0.1',
    PXDF_PORT: String(SIDECAR_PORT),
    PXDF_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
    PXDF_PICK_MEDIA: clips.map((clip) => clip.path).join(':'),
    PXDF_CUE_SEED: JSON.stringify(Object.fromEntries(clips.map((clip) => [clip.path, { loop: null, trimStartMs: 0, trimEndMs: null }]))),
  }
  // Never inherited. `SOAK_FAULT` passes a `PXDF_FAULT_DECODE` spec through on
  // purpose, to show the soak counts the black a live decode error leaves on
  // stock main; a result taken with it says so in its `fault` field.
  delete env.PXDF_FAULT_DECODE
  if (process.env.SOAK_FAULT !== undefined) env.PXDF_FAULT_DECODE = process.env.SOAK_FAULT
  delete env.PXDF_STREAM_PACING
  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(workspace, 'profile')}`],
    { cwd: APP_DIR, env, stdio: 'ignore', detached: true },
  )
  page = await attachToPage()
  const waitFor = async (expression, attempts = 50) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await page.evaluate(expression)
      if (value) return value
      await sleep(200)
    }
    return null
  }

  if (await waitFor('document.querySelector(".mapping-screen") !== null') === null) throw new Error('the Mapping surface never mounted')
  for (const [label, value] of [['Floor type', FLOOR.type], ['Floor width in tiles', FLOOR.cols], ['Floor height in tiles', FLOOR.rows]]) {
    const current = await page.evaluate(`document.querySelector('[aria-label="${label}"]')?.value ?? null`)
    if (current === null) throw new Error(`no select labelled ${label}`)
    if (current !== String(value)) await page.evaluate(selectScript(label, value))
    await sleep(300)
  }
  await page.evaluate(clickButtonScript('Open Player'))
  if (await waitFor('document.querySelector(\'[aria-label="Add cue"]\') !== null') === null) throw new Error('the Play surface never mounted')
  await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
  await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('.add-menu [role="menuitem"]')].find((b) => b.textContent.includes('Upload'))
    if (item === undefined) throw new Error('no Upload item in the + menu')
    item.click()
  })()`)
  if (await waitFor(`document.querySelectorAll(".cue-row").length === ${CUES.length}`) === null) {
    throw new Error(`the ${CUES.length} fixtures never reached the cue stack`)
  }
  // Give thumbnails and duration probes time to finish, so they are not part of the soak.
  await sleep(3_000)

  const { trace, endMs } = buildTrace(SEED, SOAK_SECONDS)
  const actions = []
  let live = null
  tap.reset()
  const start = Date.now()
  for (const step of trace) {
    const wait = start + step.at - Date.now()
    if (wait > 0) await sleep(wait)
    if (step.kind === 'go') {
      await page.evaluate(`document.querySelectorAll(".cue-row")[${step.cue}].click()`)
      const standby = await waitFor(
        `document.querySelectorAll(".cue-row")[${step.cue}]?.querySelector(".standby-marker") !== null ? 1 : 0`, 10) === 1
      await waitFor('(() => { const b = document.querySelector(".go-button"); return b !== null && !b.disabled })()', 10)
      const t = Date.now()
      await page.evaluate('document.querySelector(".go-button").click()')
      actions.push({ ...step, t, standby, outgoing: live })
      live = step.cue
    } else {
      const button = step.kind === 'blackout' ? 'BLACKOUT' : 'PAUSE'
      const undo = step.kind === 'blackout' ? 'BLACKOUT' : 'RESUME'
      const t = Date.now()
      await page.evaluate(clickButtonScript(button))
      await sleep(step.holdMs)
      await page.evaluate(clickButtonScript(undo))
      actions.push({ ...step, t, tOff: Date.now() })
    }
  }
  const tail = start + endMs - Date.now()
  if (tail > 0) await sleep(tail)
  const soakEnd = Date.now()
  const frames = assembleFrames(tap.packets, tap.times, layout)
  const packetCount = tap.packets.length
  tap.reset()

  await page.evaluate(clickButtonScript('Mapping')).catch(() => {})
  const exceptions = [...page.exceptions.values()]
  page.close()
  page = null
  try { process.kill(-electron.pid, 'SIGTERM') } catch { /* already gone */ }
  await sleep(2_000)
  try { process.kill(-electron.pid, 'SIGKILL') } catch { /* already gone */ }
  await sleep(300)
  let alive = false
  try { process.kill(-electron.pid, 0); alive = true } catch { alive = false }

  const logText = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : ''
  const result = grade(frames, actions, soakEnd)
  const heartbeats = logText.split('\n').filter((line) => line.includes('  INFO   heartbeat  '))
  const geometries = new Set(heartbeats.map((line) => /floor=(\S+ \S+)/.exec(line)?.[1]))

  // The controls, in the order the header lists them.
  if (heartbeats.length === 0 || geometries.size !== 1 || !geometries.has(`${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows}`)) {
    refuse(`1. heartbeats read ${JSON.stringify([...geometries])} over ${heartbeats.length} lines`)
  }
  if (result.frames === 0 || result.complete / result.frames < 0.99) {
    refuse(`2. ${result.complete} of ${result.frames} wire frames reassembled (${packetCount} packets)`)
  }
  const blankBlackouts = result.plannedBlackSeen.filter((n) => n === 0).length
  if (blankBlackouts > 0) refuse(`3. ${blankBlackouts} of ${result.plannedBlackSeen.length} planned BLACKOUTs held no black frame`)
  const unseenPauses = result.plannedFreezeLongest.filter((ms) => ms <= FREEZE_MS).length
  if (unseenPauses > 0) refuse(`4. ${unseenPauses} of ${result.plannedFreezeLongest.length} planned PAUSEs held no freeze > ${FREEZE_MS} ms`)
  if (result.plannedBlackSeen.length === 0 || result.plannedFreezeLongest.length === 0) {
    refuse(`3/4. the trace planned ${result.plannedBlackSeen.length} BLACKOUTs and ${result.plannedFreezeLongest.length} PAUSEs; ` +
      'both detectors need at least one — raise SOAK_SECONDS or change SEED')
  }
  // A floor on motion, not a target. A renderer composing fewer fresh frames
  // than 30 a second repeats indices, and that is a result (`moving`, graded
  // by `--compare`), not a broken instrument. MEASURED 2026-11-22: this was
  // `< 0.5`, and it refused a stock arm reading 47.3 % and threw its data away.
  if (result.moved < 0.1 || result.distinctCues < 3) {
    refuse(`5. index advanced on ${(result.moved * 100).toFixed(1)} % of steps; ${result.distinctCues} distinct cues on the wire`)
  }
  if (exceptions.length > 0) refuse(`6. the page raised: ${exceptions.map((e) => `x${e.count} ${e.text}`).join(' · ')}`)
  if (alive) refuse(`6. Electron process group ${electron.pid} survived`)
  if (refusals.length > 0) throw new Error('run controls failed')

  const heavyGo = actions.find((a) => a.segment === 'heavy')
  const baselineGo = actions.find((a) => a.segment === 'baseline')
  const drawHeavy = median(drawDuring(logText, heavyGo.t, baselineGo.t))
  const drawBaseline = median(drawDuring(logText, baselineGo.t, baselineGo.t + 20_000))
  const late = result.promotions.filter((p) => p.late)
  const summary = {
    gos: result.promotions.length,
    late: late.length,
    standbyMissed: result.promotions.filter((p) => !p.standby).length,
    stray: result.promotions.filter((p) => p.strayBefore > 0).length,
    wrong: result.promotions.reduce((n, p) => n + p.wrongAfter, 0),
    blackRuns: result.blackRuns.length,
    blackLongestMs: Math.max(0, ...result.blackRuns.map((r) => r.ms)),
    freezes: result.freezeRuns.length,
    freezeLongestMs: Math.max(0, ...result.freezeRuns.map((r) => r.ms)),
    undecoded: result.undecoded,
    moving: Number((result.moved * 100).toFixed(1)),
    latencyMedianMs: median(result.promotions.filter((p) => p.latencyMs !== null).map((p) => p.latencyMs)),
    drawHeavy,
    drawBaseline,
  }
  const logCopy = outPath.replace(/\.json$/, '') + '.log'
  copyFileSync(LOG_PATH, logCopy)
  writeFileSync(outPath, JSON.stringify({ arm, seed: SEED, soakSeconds: SOAK_SECONDS, fault: process.env.SOAK_FAULT ?? null, summary, result, actions, log: logCopy }, null, 1))

  console.log(`\n${result.frames} wire frames over ${((soakEnd - start) / 1_000).toFixed(0)} s, ` +
    `${(result.moved * 100).toFixed(1)} % of steps moving, ${result.distinctCues} cues seen`)
  console.log(`controls: ${result.plannedBlackSeen.length} BLACKOUTs all read black · ` +
    `${result.plannedFreezeLongest.length} PAUSEs all read as freezes`)
  console.log(`GOs ${summary.gos}: ${summary.late} late or missed (> ${PROMOTE_MS} ms), ${summary.stray} with a stray cue, ` +
    `${summary.wrong} wrong-cue frames, ${summary.standbyMissed} without Standby shown, median latency ${summary.latencyMedianMs} ms`)
  console.log(`unplanned black: ${summary.blackRuns} runs, longest ${summary.blackLongestMs} ms`)
  console.log(`freezes > ${FREEZE_MS} ms: ${summary.freezes}, longest ${summary.freezeLongestMs} ms`)
  console.log(`undecoded frames: ${summary.undecoded}`)
  console.log(`draw, median of heartbeat averages: 2160² ${drawHeavy} ms · 768² ${drawBaseline} ms`)
  for (const p of late) console.log(`  late: cue ${p.cue} ${p.latencyMs === null ? 'never reached the wire' : `${p.latencyMs} ms`}`)
  for (const r of result.blackRuns) console.log(`  black: ${r.ms} ms at +${r.from - start} ms`)
  for (const r of result.freezeRuns) console.log(`  freeze: cue ${r.cue} index ${r.index} for ${r.ms} ms at +${r.from - start} ms`)
  console.log(`\nresult: ${outPath}\nlog:    ${logCopy}`)
} catch (error) {
  if (refusals.length > 0) {
    console.log(`\nREFUSED — the instrument is broken; no result written:\n  - ${refusals.join('\n  - ')}`)
    exitCode = 2
  } else {
    console.log(`\nthe soak did not complete: ${error instanceof Error ? error.stack : String(error)}`)
    exitCode = 1
  }
} finally {
  page?.close()
  if (electron !== null) {
    try { process.kill(-electron.pid, 'SIGKILL') } catch { /* already gone */ }
  }
  tap.close()
  rmSync(workspace, { recursive: true, force: true })
}
process.exit(exitCode)
