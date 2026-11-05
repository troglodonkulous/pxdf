/**
 * What cadence does the floor actually receive, with the renderer uncapped?
 *
 * **A measurement, not a gate.** Nothing runs it automatically. It exists to
 * take a baseline before a proposed change: capping the renderer at 30 fps.
 *
 *     node test/e2e/probe-render-rate.mjs          # needs `npm run build` first
 *     WINDOW_SECONDS=20 node test/e2e/probe-render-rate.mjs
 *
 * ## The question
 *
 * `App.tsx`'s `render` runs on `requestAnimationFrame` (~60 Hz) and composes and
 * writes a frame every time. The sidecar is `mapper stream --fps 30`: a one-slot
 * `LatestFrame` mailbox read by a `perf_counter` metronome. So about half of the
 * composed frames are overwritten unsent, and a 30 fps cap would halve compose
 * cost. The risk of the cap is two independent ~30 Hz clocks beating against
 * each other — repeat one frame, skip the next — which **no byte comparison in
 * this project can see**: every frame on the wire is a correct frame, only the
 * spacing between source frames is wrong. So this reads the spacing.
 *
 * ## The instrument
 *
 * Each clip is authored here, at probe time, with its own **source frame index
 * written into the picture**: twelve bits as whole black/white tiles, their
 * twelve complements, one white and one black marker tile. The app plays it
 * through the real path (decoder, compose at `floor_px x S`, one downsample,
 * `writeFrame`, `mapper stream`), and this script reads UDP off 127.0.0.1,
 * reassembles each wire frame by its headers, un-maps it with `mapper`'s own
 * `send_buffer_sources`, and decodes the index. The step between consecutive
 * wire frames is the cadence: at a 30 fps sender, a 60 fps source should step
 * 2, a 30 fps source 1, and a 24 fps source 1 four times in five and 0 once.
 * Anything else is a **cadence error**, which is the operator-visible
 * consequence (judder).
 *
 * During the capture window this script sends **nothing** over CDP. A polling
 * `Runtime.evaluate` runs on the renderer's main thread and would perturb the
 * very frame timing being measured; the socket stays open only so the page's
 * uncaught exceptions still arrive.
 *
 * ## Positive controls — a failure in any one means the instrument is broken
 *
 * No table is printed, the reasons are, and the exit is 2.
 *
 *  0a. Every frame of every generated clip, decoded back by ffmpeg and area-
 *      scaled to 80 x 80, reads as its own index. (The fixture says what it
 *      claims to say.)
 *  0b. A known frame packetised by `mapper`'s own `build_frame` reassembles and
 *      decodes to its index here. (The wire decoder is not guessing at the
 *      mapping.)
 *  1.  Every heartbeat inside the window reads `floor=8x8_4P 10x10`, and there
 *      is at least one. (The geometry was actually driven.)
 *  2.  >= 99 % of wire frames decode to a valid index.
 *  3.  Wire rate within 29-31 fps. Under `--pacing arrival`, at most 31: it
 *      sends what the renderer writes, so a write it never sent is a skip — a
 *      result — and only its ceiling is a control (as in the stream probe).
 *  4.  **Time axis**, every arm: the mean step over the steady steps is within
 *      ±2 % of `source_fps / 30`. That is how far the source advances per wire
 *      frame whatever the cadence, so a decoder reading the wrong bits, a lost
 *      run of frames or a fixed index cannot satisfy it. Under `arrival` the
 *      divisor is the arm's measured wire rate, for the reason in 3.
 *  5.  **Repeat detector**, 24 fps arm: >= 15 % of steady steps are repeats.
 *      24-in-30 has to repeat at least one step in five — with a mean of 0.8
 *      and no backward steps, repeats are >= 20 % by arithmetic — so a
 *      detector reading ~0 there is blind, and a clean 30 fps result from it
 *      would mean nothing. Graded only on an arm whose wire owes repeats
 *      (wire rate >= 1.18 x source): under `arrival`, a renderer that
 *      composes on new video frames sends a 24 fps clip at 24 fps and owes
 *      none. A run with a 24 fps arm in which no arm owed them refuses.
 *  6.  The page raised no uncaught exception, and no Electron survived.
 *  1b. **The sender under test is the one named.** `mapper stream` states its
 *      own pacing in its opening line (`sending to … pacing <mode>, …`), which
 *      the sidecar logs. Every such line in the arm's log must name the arm's
 *      mode, and there must be at least one. The argv is not enough: it says
 *      what was asked for, and an inherited `DDF_STREAM_PACING` or a `mapper`
 *      that ignored the flag would grade one sender under another's name.
 *  7.  **The interval grade can see unevenness, and does not invent it.** Before
 *      any launch, a Python sender puts `mapper`'s own packetisation of a known
 *      frame on the tap at a known schedule — 30 even ticks, 60 alternating
 *      23.3 / 43.3 ms, 30 even — stamping each frame's last `sendto` with
 *      `perf_counter`. Every frame must arrive, >= 95 % of the tap's intervals
 *      must agree with the sender's to within 2 ms, and the tap's intervals must
 *      show the injected spread (p99 - p50 >= 8 ms, the stream probe's control 8
 *      bound). On macOS both clocks are `mach_absolute_time`, so intervals
 *      compare across processes without an offset. This is the instrument the
 *      interval p50/p99/max below is read through; if it smooths, delays or
 *      bunches packets, no pacing mode's intervals mean anything.
 *  8.  **The renderer trace sees every compose** (see "The renderer trace"):
 *      its composes per second in the window agree with the app's own
 *      heartbeat to ±5 %, and it did not hit its buffer cap.
 *  9.  >= 99 % of traced composes decode to a valid index, and >= 100 of them.
 *  10. **The trace and the wire read the same frames**: >= 98 % of the indices
 *      the wire carried were among those the trace saw composed. A trace
 *      decoding the wrong bits, or watching the wrong canvas, fails it.
 *
 * A valid run exits 0 whatever the cadence numbers are.
 *
 * ## The renderer trace
 *
 * The wire shows a repeat or skip; it cannot say which handoff made it. The
 * trace (`TRACE_SCRIPT`) records, at the renderer, the source index each
 * compose actually drew, so `rend. steps` / `renderer err` are the renderer's
 * own cadence, and the wire's can be compared against them.
 *
 *     TRACE_RVFC=0 …   # trace without its own requestVideoFrameCallback chain
 *
 * **The trace's rVFC chain is not a passive observer.** With it on, the
 * shipped renderer's 30-on-30 errors under `arrival` read 0.00-0.41 %; with it
 * off, 0.82-8.23 % (3 runs each, 2026-09-29): keeping a frame callback
 * registered on a detached `<video>` changes how Chromium hands it frames. So
 * a *baseline* of a renderer that does not keep its own chain must be taken
 * with `TRACE_RVFC=0`. It is on by default because it is what attributes an
 * error (`presented between`) and compares the drawn frame against rVFC's
 * report (`drawn vs rVFC`), and on a renderer that keeps its own chain it
 * adds nothing Chromium was not already doing.
 *
 * ## Pacing modes (docs/APP-PLAN.md, cadence step 6)
 *
 *     PACINGS=clock,arrival SOURCES=60,30,24 REPEATS=1   # the defaults
 *     FAIL_FAST=1 …   # stop after the first arm that fails a control, exit 2
 *
 * Each arm is one pacing mode × one source rate, launched with
 * `DDF_STREAM_PACING` set to the mode (`clock` launches with it *unset*, which
 * is what ships). Arms run interleaved — every mode at one source rate, then
 * the next source, then the next repeat — so drift in machine load lands on
 * every mode alike rather than on whichever ran last. The capped renderer's
 * 30-on-30 result was bimodal across runs (0.23-36 %), so one run per mode
 * decides nothing; set `REPEATS`. Graded per arm: cadence errors, and the
 * wire-interval p50/p99/max through the tap control 7 vouches for. Each arm's
 * controls print as soon as it finishes, so a refusal is visible then, not
 * at the end. A third mode, `precise`, was graded here and removed on
 * 2026-09-29 (captures/measurements/README.md); re-run it from commit d3d6060.
 *
 * ## Control 5 was changed after seeing data, and why that is not a loosened gate
 *
 * The first version read "repeats on 15-25 % of the 24 fps arm's steps", and
 * refused on the first real run at 28.2 % (and 32.1 % over 60 s). The 25 %
 * ceiling was a guess, never derived. It assumed the uncapped pipeline puts a
 * clean 1-in-5 pulldown on the wire. That makes it a measure of **cadence
 * quality, which is the quantity under test**, not of instrument health. The
 * run it refused had a mean step of 0.800 exactly, and its excess repeats were
 * paid back one-for-one by skips. That is a detector seeing judder, not a blind
 * one. So the ceiling came out and the time-axis check (4) went in on every
 * arm.
 *
 * The replacement refuses everything the old one was for. Mutation-checked
 * against this file:
 *
 * - Every wire frame forced to one fixed index: mean step 0.000 in all three
 *   arms. Control 4 refused it, exit 2. Control 5 passed it, because 100 %
 *   repeats is ">= 15 %". The floor on repeats catches only a blind detector.
 *   A detector that sees nothing but repeats is caught by the time axis,
 *   which is why control 4 exists.
 * - Two bit tiles swapped in `decodeIndex`: refused before any launch, by
 *   controls 0a and 0b. Exit 2.
 *
 * ## The loop seam, kept out of the cadence numbers
 *
 * The clips loop, and `VideoSource` restarts on `ended` with a seek rather than
 * `video.loop`. That restart is its own judder and not the one this probe
 * exists to measure, so steps with either end inside the first or last half
 * second of the clip are counted separately as `seam` and excluded from the
 * cadence histogram and from controls 4 and 5.
 *
 * ## One cost, stated
 *
 * Each arm launches Electron, which rotates `~/Library/Logs/Electron/ddf.log`.
 * Six arms per repeat, six rotations: **copy that log first** if it holds
 * anything you care about, and do not run this beside `wire.mjs` or another
 * probe. The probe reads each arm's log before launching the next.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

/** Distinct from 9333-9338 and 9355 (wire.mjs and the other probes). */
const DEBUG_PORT = 9_339
/** Distinct from 60001-60003 and 60009. */
const SIDECAR_PORT = 60_004
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const REPO_ROOT = resolve(APP_DIR, '..')
const PYTHON = process.env.DDF_PYTHON ?? 'python3'
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'Electron', 'ddf.log')

const FLOOR = { type: '8x8_4P', cols: 10, rows: 10 }
/** Floor pixels per tile for `8x8_4P`. The code tiles are whole floor tiles. */
const TILE = 8
const WIDTH_PX = FLOOR.cols * TILE
const HEIGHT_PX = FLOOR.rows * TILE
/** Source pixels per code tile. 160 x 160 cover-fits 80 x 80 exactly. */
const SRC_TILE = 16
const SRC_PX = FLOOR.cols * SRC_TILE

const WINDOW_SECONDS = Number(process.env.WINDOW_SECONDS ?? '60')
const CLIP_SECONDS = Number(process.env.CLIP_SECONDS ?? '20')
const HEARTBEAT_SECONDS = 10
const SETTLE_MS = 3_000
const SEAM_SECONDS = 0.5
const SENDER_FPS = 30

/** Each source rate, the steps it should show, and the mean step. */
const SOURCE_ARMS = [
  { fps: 60, allowed: [2], expectedMean: 2 },
  { fps: 30, allowed: [1], expectedMean: 1 },
  { fps: 24, allowed: [0, 1], expectedMean: 0.8 },
]
/** `mapper stream --pacing`'s choices. `clock` is its default and what ships. */
const PACING_MODES = ['clock', 'arrival']

const listEnv = (name, fallback) => (process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
const PACINGS = listEnv('PACINGS', PACING_MODES.join(','))
const SOURCES = listEnv('SOURCES', SOURCE_ARMS.map((a) => a.fps).join(',')).map(Number)
const REPEATS = Number(process.env.REPEATS ?? '1')

/** Interleaved: every pacing at one source, then the next source, then the next repeat. */
const ARMS = []
for (let repeat = 1; repeat <= REPEATS; repeat++) {
  for (const fps of SOURCES) {
    for (const pacing of PACINGS) {
      const source = SOURCE_ARMS.find((a) => a.fps === fps)
      ARMS.push({ ...source, pacing, repeat, tag: `${pacing} ${String(fps).padStart(2)} fps #${repeat}` })
    }
  }
}

/** Control 7's schedule, in seconds between frames: even, uneven by ±10 ms, even. */
const TICK = 1 / SENDER_FPS
const INJECTED_GAPS = [
  ...Array(30).fill(TICK),
  ...Array.from({ length: 60 }, (_, i) => TICK + (i % 2 === 0 ? -0.010 : 0.010)),
  ...Array(30).fill(TICK),
]
const TAP_AGREE_MS = 2
const TAP_AGREE_SHARE = 0.95
/** The stream probe's control 8 bound, for the same quantity. */
const INJECTED_SPREAD_MIN_MS = 8

// ------------------------------------------------------------- the code tiles

const BITS = 12
const bitTile = (b) => (b < 10 ? [b, 0] : [b - 10, 1])
const complementTile = (b) => (b < 10 ? [b, 2] : [b - 10, 3])
const WHITE_MARK = [9, 1]
const BLACK_MARK = [9, 3]

/** A grey image, `10 * tilePx` square, carrying `index` in its code tiles. */
function drawPattern(index, tilePx) {
  const side = FLOOR.cols * tilePx
  const image = new Uint8Array(side * side)
  const fill = ([col, row], value) => {
    for (let y = row * tilePx; y < (row + 1) * tilePx; y++) {
      image.fill(value, y * side + col * tilePx, y * side + (col + 1) * tilePx)
    }
  }
  for (let b = 0; b < BITS; b++) {
    const bit = (index >> b) & 1
    fill(bitTile(b), bit ? 255 : 0)
    fill(complementTile(b), bit ? 0 : 255)
  }
  fill(WHITE_MARK, 255)
  // BLACK_MARK and everything else stay 0.
  return image
}

/**
 * The source index an 80 x 80 RGB framebuffer carries, or `null`.
 *
 * Reads the centre 4 x 4 of each code tile, so a blended tile edge from
 * scaling or chroma subsampling cannot flip a bit. Every tile must be decisive
 * (< 64 or > 192), both markers right, and every bit must equal the inverse of
 * its complement — a frame that is black, white, torn or mis-mapped fails at
 * least one of those, rather than decoding to some plausible number.
 */
function decodeIndex(rgb) {
  const lum = ([col, row]) => {
    let sum = 0
    for (let y = row * TILE + 2; y < row * TILE + 6; y++) {
      for (let x = col * TILE + 2; x < col * TILE + 6; x++) {
        const p = (y * WIDTH_PX + x) * 3
        sum += rgb[p] + rgb[p + 1] + rgb[p + 2]
      }
    }
    return sum / 48
  }
  const level = (tile) => {
    const value = lum(tile)
    if (value > 192) return 1
    if (value < 64) return 0
    return null
  }
  if (level(WHITE_MARK) !== 1 || level(BLACK_MARK) !== 0) return null
  let index = 0
  for (let b = 0; b < BITS; b++) {
    const bit = level(bitTile(b))
    const complement = level(complementTile(b))
    if (bit === null || complement === null || bit === complement) return null
    index |= bit << b
  }
  return index
}

// ------------------------------------------------------------------ fixtures

function makeClip(directory, fps) {
  const frames = Math.round(CLIP_SECONDS * fps)
  const raw = Buffer.alloc(frames * SRC_PX * SRC_PX)
  for (let i = 0; i < frames; i++) raw.set(drawPattern(i, SRC_TILE), i * SRC_PX * SRC_PX)
  const path = join(directory, `index-${fps}fps.mp4`)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SRC_PX}x${SRC_PX}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', path,
  ], { input: raw, maxBuffer: 1 << 26 })
  return { path, frames }
}

/** Control 0a: every frame of the clip, decoded back, reads as its own index. */
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
    if (decodeIndex(out.subarray(i * frameBytes, (i + 1) * frameBytes)) !== i) wrong += 1
  }
  if (decoded !== clip.frames || wrong > 0) {
    return `the fixture ${clip.path} decodes to ${decoded} frames (want ${clip.frames}), ` +
      `${wrong} of them not reading as their own index`
  }
  return null
}

/**
 * The floor's wire layout from `mapper` itself, and a known frame run through
 * `mapper`'s own packetiser — so the reassembly below is graded against the
 * code that writes the wire rather than against a copy of it.
 */
function mapperLayout(knownIndex) {
  const grey = drawPattern(knownIndex, TILE)
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

/**
 * Wire frames from a packet stream: `{ t, index }`, with `index` null for a
 * frame that did not decode and `complete` false for one that did not
 * reassemble. The partial frame before the first end-of-frame is dropped.
 */
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
  if (packets.length !== layout.packetsPerFrame) return { complete: false, index: null }
  // `bytesPerFrame` counts headers too; the send buffer is bodies only.
  const payloadBytes = layout.widthPx * layout.heightPx * 3
  const buffer = Buffer.alloc(payloadBytes)
  const seen = new Set()
  let bytes = 0
  for (const packet of packets) {
    const key = `${packet[1]}/${packet[3]}/${packet[4] & 0x7f}`
    if (seen.has(key)) return { complete: false, index: null }
    seen.add(key)
    const tileCol = layout.portsPerController * packet[1] + packet[3]
    const start = tileCol * layout.portDataSize + (packet[4] & 0x7f) * layout.bodyMax
    const body = packet.subarray(HEADER_LEN)
    body.copy(buffer, start)
    bytes += body.length
  }
  if (bytes !== payloadBytes) return { complete: false, index: null }
  // Send buffer (BGR, wire order) -> RGB framebuffer, the inverse of
  // `mapper/frame.py:pack_send_buffer`.
  const rgb = Buffer.alloc(payloadBytes)
  layout.sources.forEach((source, slot) => {
    rgb[source * 3] = buffer[slot * 3 + 2]
    rgb[source * 3 + 1] = buffer[slot * 3 + 1]
    rgb[source * 3 + 2] = buffer[slot * 3]
  })
  return { complete: true, index: decodeIndex(rgb) }
}

/** Packets and bytes per frame over a window, as `wire.mjs`'s `frameShape`. */
function frameShape(packets, controllerCount) {
  const controllers = new Set(packets.map((packet) => packet[1]))
  if (packets.length === 0 || controllers.size !== controllerCount) return null
  const lastController = Math.max(...controllers)
  const ends = []
  for (let i = 0; i < packets.length; i++) {
    if (isEndOfFrame(packets[i]) && packets[i][1] === lastController) ends.push(i)
  }
  if (ends.length < 2) return null
  const body = packets.slice(ends[0] + 1, ends[ends.length - 1] + 1)
  return { packetsPerFrame: body.length / (ends.length - 1), bytesPerFrame: body.reduce((n, p) => n + p.length, 0) / (ends.length - 1) }
}

class WireTap {
  constructor() {
    this.packets = []
    this.times = []
    this.socket = createSocket('udp4')
    this.socket.on('message', (message) => {
      this.packets.push(message)
      this.times.push(performance.now())
    })
  }

  listen() {
    return new Promise((done) => this.socket.bind(SIDECAR_PORT, '127.0.0.1', () => {
      try { this.socket.setRecvBufferSize(8 << 20) } catch { /* the default still holds several frames */ }
      done()
    }))
  }

  async window(ms) {
    const from = this.packets.length
    await sleep(ms)
    return this.packets.slice(from)
  }

  /** Drop everything captured so far, so memory holds one arm's window only. */
  reset() {
    this.packets = []
    this.times = []
  }

  close() {
    this.socket.close()
  }
}

/**
 * Control 7: a known schedule, sent by Python, read back through `tap`.
 *
 * The sender runs as a child process with Node's event loop free — a
 * synchronous spawn would park the loop, the packets would queue in the socket
 * buffer, and every one would be stamped in a burst when it returned.
 */
async function checkIntervalTap(tap, layout, knownIndex) {
  const grey = drawPattern(knownIndex, TILE)
  const rgb = Buffer.alloc(grey.length * 3)
  for (let i = 0; i < grey.length; i++) rgb.fill(grey[i], i * 3, i * 3 + 3)
  const script = `
import json, socket, sys, time
from mapper.floors import FloorConfig
from mapper.frame import build_frame
from mapper.sender import sleep_until
c = FloorConfig.of(${JSON.stringify(FLOOR.type)}, ${FLOOR.cols}, ${FLOOR.rows})
packets = build_frame(c, sys.stdin.buffer.read())
gaps = json.loads(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
stamps = []
at = time.perf_counter() + 0.2
for gap in [0.0] + gaps:
    at += gap
    sleep_until(at)
    for p in packets:
        s.sendto(p, ("127.0.0.1", ${SIDECAR_PORT}))
    stamps.append(time.perf_counter())
print(json.dumps(stamps))
`
  tap.reset()
  const stamps = await new Promise((done, fail) => {
    const child = spawn(PYTHON, ['-c', script, JSON.stringify(INJECTED_GAPS)], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', fail)
    child.on('close', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`control 7 sender exited ${code}: ${err.trim()}`))))
    child.stdin.end(rgb)
  })
  await sleep(200)
  const frames = assembleFrames(tap.packets, tap.times, layout)
  tap.reset()

  // `assembleFrames` drops everything up to the first end-of-frame, so the
  // first frame sent is never counted: tap frame k is sent frame k + 1.
  const sent = stamps.slice(1)
  const problems = []
  if (frames.length !== sent.length || frames.some((f) => f.index !== knownIndex)) {
    problems.push(`${frames.length} frames reached the tap (want ${sent.length}), ` +
      `${frames.filter((f) => f.index !== knownIndex).length} not decoding as ${knownIndex}`)
    return { problems, line: 'frames lost or undecoded' }
  }
  const tapGaps = []
  const disagreements = []
  for (let i = 1; i < frames.length; i++) {
    const measured = frames[i].t - frames[i - 1].t
    tapGaps.push(measured)
    disagreements.push(Math.abs(measured - (sent[i] - sent[i - 1]) * 1_000))
  }
  const agree = disagreements.filter((d) => d <= TAP_AGREE_MS).length / disagreements.length
  const sorted = [...tapGaps].sort((a, b) => a - b)
  const spread = quantile(sorted, 0.99) - quantile(sorted, 0.5)
  const worst = Math.max(...disagreements)
  if (agree < TAP_AGREE_SHARE) {
    problems.push(`only ${(agree * 100).toFixed(1)} % of tap intervals are within ${TAP_AGREE_MS} ms of the sender's ` +
      `(need ${TAP_AGREE_SHARE * 100} %; worst ${worst.toFixed(2)} ms) — the tap does not read wire intervals as sent`)
  }
  if (spread < INJECTED_SPREAD_MIN_MS) {
    problems.push(`±10 ms of injected unevenness read as tap p99 - p50 = ${spread.toFixed(2)} ms, ` +
      `needs >= ${INJECTED_SPREAD_MIN_MS} — the interval grade cannot see unevenness`)
  }
  return {
    problems,
    line: `${frames.length}/${sent.length} frames, ${(agree * 100).toFixed(1)} % of intervals within ${TAP_AGREE_MS} ms ` +
      `of the sender's (worst ${worst.toFixed(2)} ms), p99 - p50 ${spread.toFixed(2)} ms`,
  }
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

/** `wire.mjs`'s `selectScript`: the native-setter dance React needs. */
const selectScript = (label, value) => `(() => {
  const select = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})
  if (select === null) throw new Error('no select labelled ${label}')
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, ${JSON.stringify(String(value))})
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return select.value
})()`

// ------------------------------------------------------------ renderer trace

/**
 * The wire says a frame was repeated or skipped; it cannot say where. Under
 * `--pacing arrival` the sender forwards each write once, so a wire repeat is
 * the renderer composing one video frame twice — but that is an inference from
 * the pipe's behaviour, not something seen at the renderer. This trace sees it.
 *
 * Installed over CDP before GO, read back after the window, and silent in
 * between (the probe's own rule: nothing is sent to the page during the
 * window). It wraps two prototype methods in the page's main world:
 *
 * - `drawImage` with an `HTMLVideoElement` onto a work-sized canvas (square, a
 *   multiple of the floor's 10 tiles, at least 2 x 80) notes the element, its
 *   `currentTime`, and the newest `requestVideoFrameCallback` metadata seen
 *   for it; and the first time it sees an element, starts an rVFC chain on it.
 * - the `getImageData` that follows on the same context samples the centre of
 *   each of the 26 code tiles out of the pixels it returns, which is exactly
 *   what `composeFrame` downsamples and writes.
 *
 * Plus an rAF chain, for the display's own timeline. Timestamps are the
 * page's `performance.now()`, a different origin from this script's; the
 * window is marked by reading the page's clock just before and just after it.
 *
 * Controls 8-10 below say whether the trace is reading what was written.
 */
const TRACE_RVFC = process.env.TRACE_RVFC !== '0'
const TRACE_SCRIPT = `(() => {
  if (window.__ddfTrace !== undefined) return 'already installed'
  const CAP = 40000
  const trace = { composes: [], frames: [], rafs: [], ids: new WeakMap(), latest: new WeakMap(), nextId: 1 }
  const idOf = (video) => {
    let id = trace.ids.get(video)
    if (id === undefined) {
      id = trace.nextId++
      trace.ids.set(video, id)
      const onFrame = (now, meta) => {
        if (trace.frames.length < CAP) {
          trace.frames.push([id, now, meta.mediaTime, meta.presentedFrames, meta.expectedDisplayTime, performance.now()])
        }
        trace.latest.set(video, meta)
        video.requestVideoFrameCallback(onFrame)
      }
      if (${TRACE_RVFC} && typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(onFrame)
    }
    return id
  }
  const workSized = (canvas) => canvas.width === canvas.height && canvas.width >= 160 && canvas.width % 10 === 0
  const draw = CanvasRenderingContext2D.prototype.drawImage
  const read = CanvasRenderingContext2D.prototype.getImageData
  CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
    if (image instanceof HTMLVideoElement && workSized(this.canvas)) {
      const meta = trace.latest.get(image)
      this.__ddfDrawn = [idOf(image), performance.now(), image.currentTime,
        meta === undefined ? -1 : meta.presentedFrames, meta === undefined ? -1 : meta.mediaTime]
    }
    return draw.call(this, image, ...rest)
  }
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const image = read.apply(this, args)
    const drawn = this.__ddfDrawn
    this.__ddfDrawn = undefined
    if (drawn !== undefined && trace.composes.length < CAP && image.width === this.canvas.width) {
      const width = image.width
      const tile = width / 10
      const lum = (col, row) => {
        let sum = 0
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) {
            const x = Math.floor(col * tile + tile * (0.3 + 0.4 * i / 3))
            const y = Math.floor(row * tile + tile * (0.3 + 0.4 * j / 3))
            const p = (y * width + x) * 4
            sum += image.data[p] + image.data[p + 1] + image.data[p + 2]
          }
        }
        return Math.round(sum / 48)
      }
      const tiles = ${JSON.stringify([WHITE_MARK, BLACK_MARK, ...Array.from({ length: BITS }, (_, b) => bitTile(b)), ...Array.from({ length: BITS }, (_, b) => complementTile(b))])}
      trace.composes.push([...drawn, ...tiles.map(([c, r]) => lum(c, r))])
    }
    return image
  }
  const onRaf = (now) => {
    if (trace.rafs.length < CAP) trace.rafs.push(now)
    requestAnimationFrame(onRaf)
  }
  requestAnimationFrame(onRaf)
  window.__ddfTrace = {
    dump: () => ({ composes: trace.composes, frames: trace.frames, rafs: trace.rafs, capped: trace.composes.length >= CAP || trace.frames.length >= CAP }),
  }
  return 'installed'
})()`

/** The index a traced compose's 26 tile samples carry, by `decodeIndex`'s rule. */
function decodeTraceTiles(lums) {
  const level = (v) => (v > 192 ? 1 : v < 64 ? 0 : null)
  if (level(lums[0]) !== 1 || level(lums[1]) !== 0) return null
  let index = 0
  for (let b = 0; b < BITS; b++) {
    const bit = level(lums[2 + b])
    const complement = level(lums[2 + BITS + b])
    if (bit === null || complement === null || bit === complement) return null
    index |= bit << b
  }
  return index
}

/**
 * The renderer's side of one arm: which source frame each compose drew, how
 * the video presented frames between composes, and whether the trace agrees
 * with the wire it fed.
 */
function analyseTrace(arm, clip, dump, from, to, wireFrames) {
  const inWindow = (t) => t >= from && t <= to
  const all = dump.composes.filter((c) => inWindow(c[1]))
  // The live video is the one composed most; any other is the preview path.
  const perVideo = new Map()
  for (const c of all) perVideo.set(c[0], (perVideo.get(c[0]) ?? 0) + 1)
  const liveId = [...perVideo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const composes = all.filter((c) => c[0] === liveId).map((c) => ({
    t: c[1], currentTime: c[2], presentedAtDraw: c[3], mediaTimeAtDraw: c[4], index: decodeTraceTiles(c.slice(5)),
  }))
  const frames = dump.frames.filter((f) => f[0] === liveId && inWindow(f[5]))
    .map((f) => ({ now: f[1], mediaTime: f[2], presented: f[3], expected: f[4], at: f[5] }))
  const rafs = dump.rafs.filter(inWindow)
  const intervalsOf = (times) => {
    const out = []
    for (let i = 1; i < times.length; i++) out.push(times[i] - times[i - 1])
    return out.sort((a, b) => a - b)
  }

  const seam = Math.round(SEAM_SECONDS * arm.fps)
  const interior = (index) => index >= seam && index < clip.frames - seam
  const histogram = new Map()
  let steady = 0
  let errors = 0
  let stepSum = 0
  // Why each off-pattern step happened, by how many new video frames the
  // element presented (rVFC callbacks) between the two composes.
  const why = new Map()
  let frameCursor = 0
  for (let i = 1; i < composes.length; i++) {
    const a = composes[i - 1]
    const b = composes[i]
    while (frameCursor < frames.length && frames[frameCursor].at <= a.t) frameCursor += 1
    let presentedBetween = 0
    for (let k = frameCursor; k < frames.length && frames[k].at <= b.t; k++) presentedBetween += 1
    if (a.index === null || b.index === null || !interior(a.index) || !interior(b.index)) continue
    const step = b.index - a.index
    steady += 1
    stepSum += step
    histogram.set(step, (histogram.get(step) ?? 0) + 1)
    if (!arm.allowed.includes(step)) {
      errors += 1
      const key = `step ${step}, ${presentedBetween} presented between`
      why.set(key, (why.get(key) ?? 0) + 1)
    }
  }

  // rVFC's own account: mediaTime advance per callback, in source frames.
  const mediaSteps = new Map()
  for (let i = 1; i < frames.length; i++) {
    const s = Math.round((frames[i].mediaTime - frames[i - 1].mediaTime) * arm.fps)
    mediaSteps.set(s, (mediaSteps.get(s) ?? 0) + 1)
  }
  const seconds = (to - from) / 1_000
  const decoded = composes.filter((c) => c.index !== null).length

  // What was drawn against what rVFC had last reported for the element: the
  // same frame, a newer one (the element's current frame moved on before its
  // callback ran), or an older one. Frame i of a clip has mediaTime i / fps.
  const drawnVsReported = new Map()
  for (const c of composes) {
    if (c.index === null || c.mediaTimeAtDraw < 0) continue
    const d = c.index - Math.round(c.mediaTimeAtDraw * arm.fps)
    const key = d === 0 ? 'same' : d > 0 ? `ahead ${d}` : `behind ${-d}`
    drawnVsReported.set(key, (drawnVsReported.get(key) ?? 0) + 1)
  }

  // Control 10: every index the wire carried was composed by the renderer.
  const composedIndices = new Set(composes.map((c) => c.index).filter((i) => i !== null))
  const wireIndices = wireFrames.map((f) => f.index).filter((i) => i !== null)
  const onWireComposed = wireIndices.filter((i) => composedIndices.has(i)).length

  return {
    liveId,
    otherVideos: [...perVideo.entries()].filter(([id]) => id !== liveId).map(([id, n]) => `#${id}:${n}`),
    composes: composes.length,
    composesAll: all.length,
    seconds,
    decoded,
    steady,
    histogram,
    meanStep: steady === 0 ? NaN : stepSum / steady,
    errors,
    why,
    frames: frames.length,
    framesPerSecond: frames.length / seconds,
    mediaSteps,
    drawnVsReported,
    frameIntervals: intervalsOf(frames.map((f) => f.at)),
    composeIntervals: intervalsOf(composes.map((c) => c.t)),
    rafIntervals: intervalsOf(rafs),
    wireIndices: wireIndices.length,
    onWireComposed,
    capped: dump.capped,
  }
}

// ------------------------------------------------------------------ heartbeat

function parseHeartbeats(text) {
  const beats = []
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+INFO\s+heartbeat\s+(.*)$/.exec(line)
    if (match === null) continue
    const body = match[2]
    const pair = (name) => {
      const m = new RegExp(`\\b${name}=([^/\\s]+)/([^\\s]+?)ms`).exec(body)
      return m === null ? null : { avg: m[1] === '-' ? null : Number(m[1]), max: m[2] === '-' ? null : Number(m[2]) }
    }
    beats.push({
      at: Date.parse(match[1]),
      line: body,
      floor: /\bfloor=(\S+ \d+x\d+)/.exec(body)?.[1] ?? null,
      frames: Number(/\bframes=(\d+)\/\d+s/.exec(body)?.[1] ?? NaN),
      seconds: Number(/\bframes=\d+\/(\d+)s/.exec(body)?.[1] ?? NaN),
      renderer: /\brenderer=(\S+)/.exec(body)?.[1] ?? null,
      composes: Number(/\bcomposes=(\d+)/.exec(body)?.[1] ?? NaN),
      draw: pair('draw'),
      readback: pair('readback'),
      pass: pair('pass'),
    })
  }
  return beats
}

/**
 * Control 1b: the pacing `mapper stream` says it runs, from each of its opening
 * lines in the log — one per spawn, and the geometry change respawns it. `null`
 * for a line that names none, which is a `mapper` that predates `--pacing`.
 */
function parseSenderPacings(text) {
  return text.split('\n')
    .filter((line) => line.includes('stdout: sending to '))
    .map((line) => /, pacing (\S+?),/.exec(line)?.[1] ?? null)
}

/** Weighted means and overall maxima across a set of heartbeats. */
function foldHeartbeats(beats) {
  const seconds = beats.reduce((n, b) => n + b.seconds, 0)
  const composes = beats.reduce((n, b) => n + b.composes, 0)
  const fold = (key) => {
    let total = 0
    let weight = 0
    let max = null
    for (const b of beats) {
      const v = b[key]
      if (v === null || v.avg === null) continue
      total += v.avg * b.composes
      weight += b.composes
      max = max === null ? v.max : Math.max(max, v.max)
    }
    return weight === 0 ? null : { avg: total / weight, max }
  }
  return {
    count: beats.length,
    composesPerSecond: composes / seconds,
    writesPerSecond: beats.reduce((n, b) => n + b.frames, 0) / seconds,
    draw: fold('draw'),
    readback: fold('readback'),
    pass: fold('pass'),
    floors: [...new Set(beats.map((b) => b.floor))],
    renderers: [...new Set(beats.map((b) => b.renderer))],
  }
}

// ----------------------------------------------------------------- analysis

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}

function analyse(arm, clip, frames) {
  const decoded = frames.filter((f) => f.index !== null).length
  const incomplete = frames.filter((f) => !f.complete).length
  const span = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1_000 : 0
  const intervals = []
  for (let i = 1; i < frames.length; i++) intervals.push(frames[i].t - frames[i - 1].t)
  const sorted = [...intervals].sort((a, b) => a - b)
  const mean = intervals.reduce((n, v) => n + v, 0) / intervals.length
  const sd = Math.sqrt(intervals.reduce((n, v) => n + (v - mean) ** 2, 0) / intervals.length)

  const seam = Math.round(SEAM_SECONDS * arm.fps)
  const interior = (index) => index >= seam && index < clip.frames - seam
  const histogram = new Map()
  const seamSteps = new Map()
  let steady = 0
  let undecodedSteps = 0
  let errors = 0
  let stepSum = 0
  const repeatGaps = new Map()
  let lastRepeatAt = null
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].index
    const b = frames[i].index
    if (a === null || b === null) {
      undecodedSteps += 1
      lastRepeatAt = null
      continue
    }
    const step = b - a
    if (!interior(a) || !interior(b)) {
      const key = step < -clip.frames / 2 ? `wrap${step + clip.frames >= 0 ? '+' : ''}${step + clip.frames}` : String(step)
      seamSteps.set(key, (seamSteps.get(key) ?? 0) + 1)
      lastRepeatAt = null
      continue
    }
    steady += 1
    stepSum += step
    histogram.set(step, (histogram.get(step) ?? 0) + 1)
    if (!arm.allowed.includes(step)) errors += 1
    if (step === 0) {
      if (lastRepeatAt !== null) {
        const gap = steady - lastRepeatAt
        repeatGaps.set(gap, (repeatGaps.get(gap) ?? 0) + 1)
      }
      lastRepeatAt = steady
    }
  }
  return {
    arm,
    frames: frames.length,
    decoded,
    incomplete,
    span,
    fps: span > 0 ? (frames.length - 1) / span : 0,
    interval: {
      mean, sd, min: sorted[0], p1: quantile(sorted, 0.01), p50: quantile(sorted, 0.5),
      p99: quantile(sorted, 0.99), max: sorted[sorted.length - 1],
    },
    steady,
    histogram,
    repeats: histogram.get(0) ?? 0,
    meanStep: steady === 0 ? NaN : stepSum / steady,
    errors,
    seamSteps,
    undecodedSteps,
    repeatGaps,
  }
}

// ----------------------------------------------------------------- one arm

async function runArm(arm, clip, layout, workspace, tap) {
  const problems = []
  let electron = null
  let page = null
  let launched = false
  let windowStart = null
  let windowEnd = null
  let frames = []
  let exceptions = []
  let trace = null
  try {
    const squatter = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(() => true, () => false)
    if (squatter) throw new Error(`something is already listening on ${DEBUG_PORT} — a leaked Electron. lsof -ti :${DEBUG_PORT} | xargs kill -9`)
    tap.reset()
    await sleep(500)
    if (tap.packets.length > 0) {
      throw new Error(`${tap.packets.length} packets arrived on ${SIDECAR_PORT} before this arm started anything — something else is sending`)
    }

    const env = {
      ...process.env,
      DDF_ADDRESS: '127.0.0.1',
      DDF_PORT: String(SIDECAR_PORT),
      DDF_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS),
      DDF_PICK_MEDIA: clip.path,
      // Looping, untrimmed. `loop: null` holds the cue and still loops the clip
      // (`show.ts`); set explicitly rather than inherited from the shell.
      DDF_CUE_SEED: JSON.stringify({ [clip.path]: { loop: null, trimStartMs: 0, trimEndMs: null } }),
    }
    // `clock` is `mapper`'s default and what ships, so it runs with the
    // variable absent — never inherited from the shell. Control 1b checks the
    // sender agrees.
    delete env.DDF_STREAM_PACING
    if (arm.pacing !== 'clock') env.DDF_STREAM_PACING = arm.pacing
    electron = spawn(
      resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
      [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${join(workspace, `profile-${arm.pacing}-${arm.fps}-${arm.repeat}`)}`],
      { cwd: APP_DIR, env, stdio: 'ignore', detached: true },
    )
    launched = true
    page = await attachToPage()

    const waitFor = async (expression, attempts = 50) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await page.evaluate(expression)
        if (value) return value
        await sleep(200)
      }
      return null
    }

    if (await waitFor('document.querySelector(".mapping-screen") !== null') === null) {
      throw new Error('the Mapping surface never mounted')
    }
    // Geometry through the Mapping UI, as the operator does it and as
    // `wire.mjs` section 4b does. Only a select whose value differs is
    // changed: each change restarts the sidecar.
    for (const [label, value] of [['Floor type', FLOOR.type], ['Floor width in tiles', FLOOR.cols], ['Floor height in tiles', FLOOR.rows]]) {
      const current = await page.evaluate(`document.querySelector('[aria-label="${label}"]')?.value ?? null`)
      if (current === null) throw new Error(`no select labelled ${label}`)
      if (current !== String(value)) await page.evaluate(selectScript(label, value))
      await sleep(300)
    }
    let shape = null
    for (let attempt = 0; attempt < 25; attempt++) {
      shape = frameShape(await tap.window(400), layout.controllers)
      if (shape !== null && shape.bytesPerFrame === layout.bytesPerFrame && shape.packetsPerFrame === layout.packetsPerFrame) break
    }
    if (shape === null || shape.bytesPerFrame !== layout.bytesPerFrame || shape.packetsPerFrame !== layout.packetsPerFrame) {
      throw new Error(`the wire never reached ${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows} ` +
        `(${layout.packetsPerFrame} packets / ${layout.bytesPerFrame} bytes): read ${JSON.stringify(shape)}`)
    }

    await page.evaluate(clickButtonScript('Open Player'))
    if (await waitFor('document.querySelector(\'[aria-label="Add cue"]\') !== null') === null) {
      throw new Error('the Play surface never mounted')
    }
    // Before GO, so the live video's first draw is already traced.
    const installed = await page.evaluate(TRACE_SCRIPT)
    if (installed !== 'installed') throw new Error(`the renderer trace did not install: ${installed}`)
    await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
    await page.evaluate(`(() => {
      const item = [...document.querySelectorAll('.add-menu [role="menuitem"]')].find((b) => b.textContent.includes('Upload'))
      if (item === undefined) throw new Error('no Upload item in the + menu')
      item.click()
    })()`)
    if (await waitFor('document.querySelectorAll(".cue-row").length === 1') === null) {
      throw new Error('the clip never reached the cue stack')
    }
    await page.evaluate('document.querySelectorAll(".cue-row")[0].click()')
    if (await waitFor('(() => { const b = document.querySelector(".go-button"); return b !== null && !b.disabled })()') === null) {
      throw new Error('GO never enabled')
    }
    await page.evaluate('document.querySelector(".go-button").click()')

    // From here on, nothing is sent to the page. Wait for the cue on the wire
    // by reading the wire.
    let live = false
    for (let attempt = 0; attempt < 30 && !live; attempt++) {
      const from = tap.packets.length
      await sleep(500)
      const recent = assembleFrames(tap.packets.slice(from), tap.times.slice(from), layout)
      live = recent.some((f) => f.index !== null)
    }
    if (!live) throw new Error('GO was pressed and no wire frame ever carried a decodable index')
    await sleep(SETTLE_MS)

    // The page's clock, read once on each side of the window and never inside it.
    const traceFrom = await page.evaluate('performance.now()')
    tap.reset()
    windowStart = Date.now()
    await sleep(WINDOW_SECONDS * 1_000)
    windowEnd = Date.now()
    const packets = tap.packets
    const times = tap.times
    tap.reset()
    const traceTo = await page.evaluate('performance.now()')
    frames = assembleFrames(packets, times, layout)
    trace = { dump: await page.evaluate('window.__ddfTrace.dump()'), from: traceFrom, to: traceTo }
    // A moment for a heartbeat stamped right at the window's end to reach the
    // log before the app is killed. Nothing from this tail is graded.
    await sleep(1_500)
    exceptions = [...page.exceptions.values()]
  } catch (error) {
    problems.push(`${arm.tag} arm did not run: ${String(error)}`)
  } finally {
    page?.close()
    if (electron !== null && electron.exitCode === null && electron.signalCode === null) {
      try { process.kill(-electron.pid, 'SIGKILL') } catch { /* already gone */ }
      await sleep(500)
    }
    if (electron !== null) {
      let alive = false
      try {
        process.kill(-electron.pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (alive) problems.push(`Electron process group ${electron.pid} survived the ${arm.tag} arm — kill it before re-running`)
    }
  }
  if (exceptions.length > 0) {
    problems.push(`the page raised uncaught exceptions during the ${arm.tag} arm: ` +
      exceptions.map((e) => `x${e.count} ${e.text}`).join('; '))
  }

  // The heartbeats that cover only the window: each covers the
  // HEARTBEAT_SECONDS before its own timestamp. Read after the child is gone.
  let beats = []
  let pacings = []
  if (launched && windowStart !== null) {
    const text = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : ''
    beats = parseHeartbeats(text).filter((b) => b.at - HEARTBEAT_SECONDS * 1_000 >= windowStart - 500 && b.at <= windowEnd + 500)
    pacings = parseSenderPacings(text)
  }
  return { problems, frames, beats, pacings, trace }
}

// --------------------------------------------------------------------- main

const f2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '-' : v.toFixed(2))
const pair = (v) => (v === null ? '-' : `${f2(v.avg)}/${f2(v.max)}`)

const refusals = []
const results = []
let repeatDetectorGraded = false
const controlLines = []
const workspace = mkdtempSync(join(tmpdir(), 'ddf-render-rate-'))
const tap = new WireTap()

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js is missing — run `npm run build` first')
  if (!(WINDOW_SECONDS >= HEARTBEAT_SECONDS * 2)) {
    throw new Error(`WINDOW_SECONDS=${WINDOW_SECONDS} is too short to hold a whole ${HEARTBEAT_SECONDS} s heartbeat reliably`)
  }
  const unknownPacing = PACINGS.filter((p) => !PACING_MODES.includes(p))
  const unknownSource = SOURCES.filter((fps) => !SOURCE_ARMS.some((a) => a.fps === fps))
  if (unknownPacing.length > 0 || unknownSource.length > 0 || !(REPEATS >= 1) || ARMS.length === 0) {
    throw new Error(`nothing valid to run: PACINGS=${PACINGS} (known ${PACING_MODES}), SOURCES=${SOURCES} ` +
      `(known ${SOURCE_ARMS.map((a) => a.fps)}), REPEATS=${REPEATS}`)
  }

  console.log(`probe-render-rate · ${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows} = ${WIDTH_PX}x${HEIGHT_PX} px · ` +
    `window ${WINDOW_SECONDS} s per arm · clips ${CLIP_SECONDS} s, ${SRC_PX}x${SRC_PX}, h264 yuv420p · ` +
    `sender ${SENDER_FPS} fps · heartbeat ${HEARTBEAT_SECONDS} s · ` +
    `renderer trace ${TRACE_RVFC ? "with" : "without"} an rVFC chain · pacings ${PACINGS.join(',')} × sources ${SOURCES.join(',')} × ${REPEATS} repeat(s) = ${ARMS.length} arms`)

  // 0b. The wire decoder, against mapper's own packetiser.
  const KNOWN = 1234
  const layout = mapperLayout(KNOWN)
  const known = assembleFrames([...layout.known, ...layout.known], layout.known.concat(layout.known).map((_, i) => i), layout)
  const knownOk = known.length === 1 && known[0].complete && known[0].index === KNOWN
  controlLines.push(`0b  mapper build_frame of index ${KNOWN} decodes here as ${known[0]?.index ?? 'nothing'}  ${knownOk ? 'ok' : 'FAILED'}`)
  if (!knownOk) refusals.push(`the wire decoder does not read mapper's own packetisation of a known frame (${JSON.stringify(known)})`)
  if (layout.widthPx !== WIDTH_PX || layout.heightPx !== HEIGHT_PX) {
    refusals.push(`mapper says ${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows} is ${layout.widthPx}x${layout.heightPx}, this probe assumed ${WIDTH_PX}x${HEIGHT_PX}`)
  }

  // 0a. The fixtures.
  const clips = new Map()
  for (const fps of SOURCES) {
    const clip = makeClip(workspace, fps)
    const fault = checkClip(clip)
    controlLines.push(`0a  ${fps} fps fixture: ${clip.frames} frames, each decodes to its own index  ${fault === null ? 'ok' : 'FAILED'}`)
    if (fault !== null) refusals.push(fault)
    clips.set(fps, clip)
  }

  if (refusals.length === 0) {
    await tap.listen()
    // 7. The tap reads intervals as sent, before anything is graded through it.
    const tapCheck = await checkIntervalTap(tap, layout, KNOWN)
    controlLines.push(`7   injected schedule through the tap: ${tapCheck.line}  ${tapCheck.problems.length === 0 ? 'ok' : 'FAILED'}`)
    refusals.push(...tapCheck.problems.map((p) => `control 7: ${p}`))
  }

  if (refusals.length === 0) {
    for (const arm of ARMS) {
      const clip = clips.get(arm.fps)
      console.log(`\n· ${arm.tag} arm: launching…`)
      const linesBefore = controlLines.length
      const refusalsBefore = refusals.length
      const { problems, frames, beats, pacings, trace } = await runArm(arm, clip, layout, workspace, tap)
      refusals.push(...problems)
      if (problems.some((p) => p.includes('did not run'))) {
        for (const problem of problems) console.log(`  REFUSED — ${problem}`)
        if (process.env.FAIL_FAST === '1') {
          console.log('  FAIL_FAST=1: stopping after this arm')
          break
        }
        continue
      }

      const result = analyse(arm, clip, frames)
      result.heartbeat = beats.length === 0 ? null : foldHeartbeats(beats)
      result.beats = beats
      result.trace = analyseTrace(arm, clip, trace.dump, trace.from, trace.to, frames)
      results.push(result)

      const tag = arm.tag
      const senderOk = pacings.length > 0 && pacings.every((p) => p === arm.pacing)
      controlLines.push(`1b  ${tag}: sender says pacing ${JSON.stringify(pacings)}  ${senderOk ? 'ok' : 'FAILED'}`)
      if (!senderOk) {
        refusals.push(`${tag} arm: mapper stream's own opening lines name pacing ${JSON.stringify(pacings)}, want only "${arm.pacing}" — ` +
          'this arm graded a different sender from the one it is labelled with')
      }
      const floorOk = beats.length > 0 && beats.every((b) => b.floor === `${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows}`)
      controlLines.push(`1   ${tag}: ${beats.length} heartbeat(s) in window, floor=${JSON.stringify(result.heartbeat?.floors ?? [])}  ${floorOk ? 'ok' : 'FAILED'}`)
      if (!floorOk) {
        refusals.push(`${tag} arm: heartbeat floor is ${JSON.stringify(result.heartbeat?.floors ?? 'absent — no heartbeat inside the window')}, ` +
          `want "${FLOOR.type} ${FLOOR.cols}x${FLOOR.rows}" — the geometry was not driven, or not read`)
      }
      const decodedShare = result.frames === 0 ? 0 : result.decoded / result.frames
      const decodeOk = result.frames > 0 && decodedShare >= 0.99
      controlLines.push(`2   ${tag}: ${result.decoded}/${result.frames} wire frames decode (${(decodedShare * 100).toFixed(2)} %)  ${decodeOk ? 'ok' : 'FAILED'}`)
      if (!decodeOk) refusals.push(`${tag} arm: only ${result.decoded} of ${result.frames} wire frames decode a valid index (need >= 99 %)`)
      // `arrival` sends what the renderer writes, so a write it never sent is a
      // skip — a result, graded as a cadence error — and only its ceiling is a
      // control. The metronome modes send 30 a second whatever arrives.
      const followsWriter = arm.pacing === 'arrival'
      const rateOk = result.fps <= 31 && (followsWriter || result.fps >= 29)
      controlLines.push(`3   ${tag}: wire ${result.fps.toFixed(2)} fps, want ${followsWriter ? '<= 31' : '29-31'}  ${rateOk ? 'ok' : 'FAILED'}`)
      if (!rateOk) refusals.push(`${tag} arm: wire rate ${result.fps.toFixed(2)} fps, want ${followsWriter ? '<= 31' : '29-31'}`)
      // 4. The time axis, every arm. See the header for why this and not a
      //    ceiling on repeats.
      const steps = [...result.histogram.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(' ')
      // The source advances `fps` a second of wall time whatever the wire rate,
      // so a sender that follows the writer is held to its own measured rate.
      const wantMean = arm.fps / (followsWriter ? result.fps : SENDER_FPS)
      const meanOk = result.steady >= 100 && Math.abs(result.meanStep - wantMean) <= 0.02 * wantMean
      controlLines.push(`4   ${tag}: mean step ${Number.isNaN(result.meanStep) ? '-' : result.meanStep.toFixed(3)} over ${result.steady} steady steps, ` +
        `want ${wantMean.toFixed(3)} ±2 %  ${meanOk ? 'ok' : 'FAILED'}`)
      if (!meanOk) {
        refusals.push(`${tag} arm: mean step ${result.meanStep.toFixed(3)} over ${result.steady} steady steps, want ${wantMean.toFixed(3)} ±2 % ` +
          `(and >= 100 steps) — the decoded index is not tracking source time, so no step in this run means anything. Steps: ${steps}`)
      }
      // 5. The repeat detector can see a repeat — on an arm whose wire owes
      //    them. Under `arrival` with a renderer that composes on new video
      //    frames, a 24 fps clip goes out at 24 fps and owes none; that arm
      //    says n/a, and a run in which no 24 fps arm owed repeats refuses
      //    below, rather than passing with the detector ungraded.
      const owedRepeats = 1 - arm.fps / result.fps
      if (arm.fps === 24 && owedRepeats < 0.15) {
        controlLines.push(`5   ${tag}: wire ${result.fps.toFixed(2)} fps owes ${(Math.max(0, owedRepeats) * 100).toFixed(1)} % repeats — n/a on this arm`)
      }
      if (arm.fps === 24 && owedRepeats >= 0.15) {
        repeatDetectorGraded = true
        const share = result.steady === 0 ? 0 : result.repeats / result.steady
        const blindOk = result.steady >= 100 && share >= 0.15
        controlLines.push(`5   ${tag}: ${result.repeats}/${result.steady} steady steps are repeats (${(share * 100).toFixed(1)} %), want >= 15 %  ${blindOk ? 'ok' : 'FAILED'}`)
        if (!blindOk) {
          refusals.push(`${tag} arm: ${result.repeats} of ${result.steady} steady steps are repeats (${(share * 100).toFixed(1)} %), ` +
            'want >= 15 % — 24-in-30 must repeat at least one step in five, so the repeat detector is blind and no cadence result ' +
            `from this run means anything. Steps: ${steps}`)
        }
      }
      // 8-10. The renderer trace reads what the renderer wrote.
      const rt = result.trace
      const hbRate = result.heartbeat?.composesPerSecond ?? NaN
      const traceRate = rt.composesAll / rt.seconds
      const rateAgrees = !rt.capped && Math.abs(traceRate - hbRate) <= 0.05 * hbRate
      controlLines.push(`8   ${tag}: trace ${traceRate.toFixed(2)} composes/s against the heartbeat's ${f2(hbRate)}${rt.capped ? ' (trace capped)' : ''}, want ±5 %  ${rateAgrees ? 'ok' : 'FAILED'}`)
      if (!rateAgrees) {
        refusals.push(`${tag} arm: the renderer trace saw ${traceRate.toFixed(2)} composes/s, the app's own heartbeat ${f2(hbRate)} — ` +
          'the trace is not seeing every compose, or is seeing something else')
      }
      const traceDecodedShare = rt.composes === 0 ? 0 : rt.decoded / rt.composes
      const traceDecodeOk = rt.composes >= 100 && traceDecodedShare >= 0.99
      controlLines.push(`9   ${tag}: ${rt.decoded}/${rt.composes} traced composes decode (${(traceDecodedShare * 100).toFixed(2)} %)  ${traceDecodeOk ? 'ok' : 'FAILED'}`)
      if (!traceDecodeOk) refusals.push(`${tag} arm: only ${rt.decoded} of ${rt.composes} traced composes decode a valid index (need >= 99 % and >= 100)`)
      const containedShare = rt.wireIndices === 0 ? 0 : rt.onWireComposed / rt.wireIndices
      const containedOk = rt.wireIndices > 0 && containedShare >= 0.98
      controlLines.push(`10  ${tag}: ${rt.onWireComposed}/${rt.wireIndices} wire indices were composed in the trace (${(containedShare * 100).toFixed(2)} %), want >= 98 %  ${containedOk ? 'ok' : 'FAILED'}`)
      if (!containedOk) {
        refusals.push(`${tag} arm: only ${rt.onWireComposed} of ${rt.wireIndices} indices on the wire appear among the traced composes — ` +
          'the trace and the wire are not reading the same frames')
      }
      for (const line of controlLines.slice(linesBefore)) console.log(`  ${line}`)
      if (refusals.length > refusalsBefore) {
        console.log(`  REFUSED — ${refusals.length - refusalsBefore} reason(s); the run cannot print a table`)
        if (process.env.FAIL_FAST === '1') {
          console.log('  FAIL_FAST=1: stopping after this arm')
          break
        }
      }
    }
    if (ARMS.some((a) => a.fps === 24) && results.some((r) => r.arm.fps === 24) && !repeatDetectorGraded) {
      controlLines.push('5   no 24 fps arm owed repeats, so the repeat detector was never graded  FAILED')
      refusals.push('control 5: no 24 fps arm in this run sent faster than its source, so nothing showed the repeat detector can see a repeat — ' +
        'add a `clock` arm (PACINGS=clock,arrival)')
    }
    controlLines.push(`6   page exceptions and surviving Electron processes: ${refusals.some((r) => r.includes('exceptions') || r.includes('survived')) ? 'FAILED' : 'none'}`)
  }
} catch (error) {
  refusals.push(`run failed: ${String(error)}`)
} finally {
  tap.close()
  rmSync(workspace, { recursive: true, force: true })
}

console.log('\npositive controls')
for (const line of controlLines) console.log(`  ${line}`)

if (refusals.length > 0) {
  console.log(`\nINSTRUMENT BROKEN — no table printed. ${refusals.length} reason(s):\n  - ${refusals.join('\n  - ')}`)
  process.exit(2)
}

console.log('\nper arm')
for (const r of results) {
  const hb = r.heartbeat
  const steps = [...r.histogram.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join('  ')
  console.log(`\n${r.arm.tag}: pacing ${r.arm.pacing}, ${r.arm.fps} fps source (expected step ${r.arm.allowed.join(' or ')}, mean ${r.arm.expectedMean})`)
  console.log(`  wire         ${r.frames} frames in ${r.span.toFixed(2)} s = ${r.fps.toFixed(2)} fps · ${r.incomplete} incomplete · ${r.decoded} decoded`)
  console.log(`  interval ms  mean ${f2(r.interval.mean)}  sd ${f2(r.interval.sd)}  min ${f2(r.interval.min)}  ` +
    `p1 ${f2(r.interval.p1)}  p50 ${f2(r.interval.p50)}  p99 ${f2(r.interval.p99)}  max ${f2(r.interval.max)}`)
  console.log(`  steps        ${steps}   (${r.steady} steady, mean ${r.meanStep.toFixed(3)})`)
  console.log(`  cadence err  ${r.errors} of ${r.steady} steady steps (${(r.errors / r.steady * 100).toFixed(2)} %) outside {${r.arm.allowed.join(',')}}`)
  if (r.arm.fps === 24) {
    const gaps = [...r.repeatGaps.entries()].sort((a, b) => a[0] - b[0]).map(([g, n]) => `${g}:${n}`).join('  ')
    console.log(`  repeat gap   ${gaps}   (steps between consecutive repeats; 5 is the ideal 24-in-30 pulldown)`)
  }
  const seam = [...r.seamSteps.entries()].map(([s, n]) => `${s}:${n}`).join('  ')
  console.log(`  loop seam    ${seam === '' ? '(none)' : seam}   · ${r.undecodedSteps} step(s) touching an undecoded frame`)
  console.log(`  renderer     ${hb.count} heartbeat(s) · composes/s ${f2(hb.composesPerSecond)} · writes/s ${f2(hb.writesPerSecond)} · ` +
    `draw ${pair(hb.draw)} · readback ${pair(hb.readback)} · pass ${pair(hb.pass)} ms avg/max · ${hb.renderers.join(',')}`)
  console.log(`  floor        ${hb.floors.join(', ')}`)
  const rt = r.trace
  const rsteps = [...rt.histogram.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join('  ')
  const q = (sorted) => `p50 ${f2(quantile(sorted, 0.5))} p99 ${f2(quantile(sorted, 0.99))} max ${f2(sorted[sorted.length - 1])}`
  console.log(`  trace        ${rt.composes} composes of video #${rt.liveId}${rt.otherVideos.length > 0 ? ` (others ${rt.otherVideos.join(' ')})` : ''} · ` +
    `compose interval ms ${q(rt.composeIntervals)} · rAF interval ms ${q(rt.rafIntervals)}`)
  console.log(`  rend. steps  ${rsteps}   (${rt.steady} steady, mean ${rt.meanStep.toFixed(3)}) · cadence err ${rt.errors} (${(rt.errors / rt.steady * 100).toFixed(2)} %)`)
  const whys = [...rt.why.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(' · ')
  console.log(`  rend. errors ${whys === '' ? '(none)' : whys}`)
  const media = [...rt.mediaSteps.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join('  ')
  const dvr = [...rt.drawnVsReported.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')
  console.log(`  drawn vs rVFC ${dvr === '' ? '-' : dvr}   (the frame drawn, against the newest one rVFC had reported)`)
  console.log(`  rVFC         ${rt.frames} callbacks = ${f2(rt.framesPerSecond)}/s · interval ms ${rt.frames > 1 ? q(rt.frameIntervals) : '-'} · mediaTime step (frames) ${media === '' ? '-' : media}`)
}

console.log('\nsummary')
console.log('pacing    src fps  rep  wire fps  interval p50/p99/max ms    sd  step 0 / 1 / 2 / other   cadence err   renderer err   rVFC/s  composes/s  draw avg/max  readback avg/max  pass avg/max')
for (const r of results) {
  const hb = r.heartbeat
  const h = (s) => r.histogram.get(s) ?? 0
  const other = r.steady - h(0) - h(1) - h(2)
  console.log([
    r.arm.pacing.padEnd(8),
    String(r.arm.fps).padStart(7),
    String(r.arm.repeat).padStart(3),
    r.fps.toFixed(2).padStart(8),
    `${f2(r.interval.p50)}/${f2(r.interval.p99)}/${f2(r.interval.max)}`.padStart(23),
    f2(r.interval.sd).padStart(5),
    `${h(0)} / ${h(1)} / ${h(2)} / ${other}`.padStart(23),
    `${r.errors} (${(r.errors / r.steady * 100).toFixed(2)} %)`.padStart(13),
    `${r.trace.errors} (${(r.trace.errors / r.trace.steady * 100).toFixed(2)} %)`.padStart(13),
    f2(r.trace.framesPerSecond).padStart(7),
    f2(hb.composesPerSecond).padStart(11),
    pair(hb.draw).padStart(13),
    pair(hb.readback).padStart(17),
    pair(hb.pass).padStart(13),
  ].join('  '))
}
console.log('\nMeasurement complete. Every positive control passed; the numbers above are a baseline, not a verdict.')
process.exit(0)
