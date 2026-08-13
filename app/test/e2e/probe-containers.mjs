/**
 * Which media containers does this Electron build actually decode?
 *
 * **This is a measurement, not a gate.** Nothing runs it automatically and
 * nothing should: it answers one question, the answer goes into
 * `src/player/mediaFormats.ts` as a dated table, and the table is what the code
 * and the tests are written against. It lives here rather than in a scratch
 * directory because the comment in that file cites it, and a cited measurement
 * whose instrument was thrown away is not evidence — it is a claim.
 *
 *     node test/e2e/probe-containers.mjs        # needs `npm run build` first
 *
 * ## Why it has to load real files in the real app
 *
 * The obvious cheap oracle is `canPlayType`, and it is wrong in both directions
 * here — it answered `no` for `mov`, which decodes, and `maybe` for `ogv`, which
 * does not. The second cheap oracle is what Chromium is generally known to
 * support, and that produced the defect this script was written to settle: a
 * filter that excluded Matroska on the grounds that browsers do not play `.mkv`,
 * when this build plays it fine. Chromium's WebM demuxer *is* a Matroska
 * demuxer.
 *
 * So the probe authors one clip per container with ffmpeg, using a codec natural
 * to that container rather than forcing H.264 everywhere, and loads each one
 * through `ddf-media://` in the running app. The distinction it can draw and the
 * cheap oracles cannot is *why* something failed: `DEMUXER_ERROR_COULD_NOT_OPEN`
 * means the container is not supported at all, while
 * `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` means the container opened and the codec
 * inside it is missing. `ogv` is the second kind — Theora was removed from
 * Chromium — and a list that recorded it as "cannot demux" would be stating
 * something false.
 *
 * ## The one non-obvious requirement
 *
 * Every probe file has to go through the picker seam. `main.ts` serves only
 * paths in `allowedMedia`, which is populated by the picker, so a file that
 * skips it comes back 403 and reads as an undecodable container. That is the
 * security model working correctly and it would silently poison every row of the
 * table, so the script clicks Add cue with `DDF_PICK_MEDIA` seeded first.
 *
 * ## The positive control, and why it exists
 *
 * `mp4` must decode. If it does not, the instrument is broken and every other
 * row is meaningless — so the script refuses to print a table at all rather than
 * printing one where everything failed.
 *
 * That guard is not hypothetical. The second run of this script produced a table
 * in which *every* container failed with `DEMUXER_ERROR_COULD_NOT_OPEN`,
 * including the ones measured decoding minutes earlier. Cause: the previous run
 * had leaked its Electron process, that process still held the debugging port,
 * and this run attached to it — reading files through an old `allowedMedia`
 * whose paths had already been deleted, which answers 403, which the demuxer
 * reports as a container it could not open. A uniformly-failing table is exactly
 * what a broken instrument produces and exactly what a real finding would look
 * like, which is the failure mode `CLAUDE.md` opens with. Hence both the port
 * pre-flight below and this control.
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DEBUG_PORT = 9_334
/** Not 60001. The wire gate uses that, and the two must be runnable together. */
const SIDECAR_PORT = 60_002
const APP_DIR = resolve(import.meta.dirname, '..', '..')

/** Container, and a codec that is natural for it rather than forced. */
const CASES = [
  { ext: 'mp4', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { ext: 'm4v', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { ext: 'mov', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { ext: 'webm', args: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p'] },
  { ext: 'mkv', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  { ext: 'avi', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] },
  // The form this repo's own test patterns are in, which is the file anyone
  // reaching for something to play will find first.
  { ext: 'avi', label: 'avi-rawvideo', args: ['-c:v', 'rawvideo', '-pix_fmt', 'bgr24'] },
  { ext: 'mpg', args: ['-c:v', 'mpeg1video'] },
  { ext: 'mpeg', args: ['-c:v', 'mpeg1video'] },
  { ext: 'ogv', args: ['-c:v', 'libtheora'] },
  { ext: 'flv', args: ['-c:v', 'flv1'] },
  { ext: 'wmv', args: ['-c:v', 'msmpeg4v3'] },
]

const MIME_GUESS = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
}

const mimeFor = (label) => (label.startsWith('avi') ? 'video/x-msvideo' : MIME_GUESS[label] ?? 'video/mp4')

function openPage(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url)
    const pending = new Map()
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
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      waiter(message)
    })
    socket.addEventListener('error', fail)
    socket.addEventListener('open', async () => {
      await send('Runtime.enable', {})
      done({
        async evaluate(expression) {
          const reply = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
          // Not optional. An earlier draft dropped this, so a click script that
          // threw "no Add cue button" returned `undefined` and the run carried
          // on with an empty `allowedMedia` — producing a table in which every
          // container failed. A page that throws must not read as a page that
          // answered.
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

const workspace = mkdtempSync(join(tmpdir(), 'ddf-probe-'))
let electron = null
let page = null
/**
 * Anything that makes the printed table untrustworthy, or that will make the
 * *next* run untrustworthy.
 *
 * The script exits non-zero on any of them. An earlier draft caught its own
 * fatal errors, printed them, and exited 0 — so a failed positive control, the
 * one guard that exists to stop a broken instrument being read as data, would
 * still have let `probe && next-thing` continue. That is the same shape as PR
 * 1's acceptance gate reporting green over the half it existed to check.
 */
const problems = []

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) {
    throw new Error('dist/main.js is missing — run `npm run build` first')
  }

  // Pre-flight: if anything already answers on the debugging port, this run
  // would attach to *that* process instead of the one it is about to launch,
  // and would then measure a stale `allowedMedia` belonging to a workspace that
  // no longer exists. Refuse rather than produce a table that looks like data.
  try {
    const stale = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    if (stale.ok) {
      throw new Error(
        `something is already listening on ${DEBUG_PORT} — a leaked Electron from a ` +
        'previous run. Kill it (`lsof -ti :' + DEBUG_PORT + ' | xargs kill -9`) and re-run.',
      )
    }
  } catch (error) {
    if (String(error).includes('already listening')) throw error
    // Connection refused is the good case: the port is free.
  }

  const made = []
  for (const testCase of CASES) {
    const label = testCase.label ?? testCase.ext
    const path = join(workspace, `${label}.${testCase.ext}`)
    try {
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2',
        ...testCase.args, path,
      ])
      made.push({ label, path })
    } catch (error) {
      // An ffmpeg build without this encoder tells us nothing about Chromium,
      // so the row is skipped rather than recorded as a failure to decode.
      console.log(`SKIP  ${label} — ffmpeg could not author it: ${String(error).split('\n')[0]}`)
    }
  }

  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DDF_ADDRESS: '127.0.0.1',
        DDF_PORT: String(SIDECAR_PORT),
        DDF_PICK_MEDIA: made.map((entry) => entry.path).join(delimiter),
      },
      stdio: 'ignore',
      // `node_modules/.bin/electron` is a Node shim that spawns the real binary
      // as its own child, so signalling the handle we hold kills the shim and
      // orphans Electron — which then keeps the debugging port and hijacks the
      // next run. Own the process group so teardown can take the whole tree.
      detached: true,
    },
  )

  for (let attempt = 0; attempt < 100 && page === null; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const target = (await response.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target !== undefined) page = await openPage(target.webSocketDebuggerUrl)
    } catch {
      // The port is not up yet.
    }
    if (page === null) await sleep(200)
  }
  if (page === null) throw new Error('Electron never exposed a debuggable page')

  // Attaching to the CDP target only means Chromium has a page — not that React
  // has mounted into it. Clicking before the button exists is the same race
  // `CLAUDE.md` documents for `wire.mjs`'s DOM reads, and here it cost four runs:
  // the click threw, the exception was swallowed, `allowedMedia` stayed empty,
  // and the table came back uniformly failing. Poll for the button; never assume
  // it is there.
  let hasButton = false
  for (let attempt = 0; attempt < 50 && !hasButton; attempt++) {
    hasButton = await page.evaluate(
      'document.querySelector(\'[aria-label="Add cue"]\') !== null')
    if (!hasButton) await sleep(200)
  }
  if (!hasButton) throw new Error('the Add cue button never appeared — the page did not mount')

  // Populate `allowedMedia` through the real picker seam. Without this every
  // row below reads 403 and the table is uniformly, wrongly, "fails".
  await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')

  // The picker resolves over IPC and the cues land asynchronously. Wait for the
  // stack to actually hold them rather than sleeping a guessed interval.
  let cueCount = 0
  for (let attempt = 0; attempt < 50 && cueCount < made.length; attempt++) {
    cueCount = await page.evaluate('document.querySelectorAll(".cue-row").length')
    if (cueCount < made.length) await sleep(200)
  }
  if (cueCount < made.length) {
    throw new Error(`only ${cueCount} of ${made.length} probe files reached the cue stack`)
  }

  const probe = async ({ label, path }) => {
    const url = `ddf-media://file${path.split('/').map(encodeURIComponent).join('/')}`
    const result = await page.evaluate(`
      new Promise((done) => {
        const v = document.createElement('video')
        v.muted = true
        v.crossOrigin = 'anonymous'
        const guess = v.canPlayType(${JSON.stringify(mimeFor(label))}) || 'no'
        v.addEventListener('loadeddata', () => done(guess + '|DECODES'))
        v.addEventListener('error', () => done(guess + '|fails: ' + (v.error?.message ?? v.error?.code)))
        setTimeout(() => done(guess + '|fails: timeout'), 5000)
        v.src = ${JSON.stringify(url)}
        v.load()
      })
    `)
    const [guess, outcome] = String(result).split('|')
    return { label, guess, outcome }
  }

  const rows = []
  for (const entry of made) rows.push(await probe(entry))

  // The positive control. See the header: a table in which everything failed is
  // what a leaked-process or 403 fault looks like, and it is indistinguishable
  // from a finding unless something that must pass is checked first.
  const control = rows.find((row) => row.label === 'mp4')
  if (control === undefined || control.outcome !== 'DECODES') {
    throw new Error(
      `positive control failed: mp4 reported "${control?.outcome ?? 'missing'}". ` +
      'mp4 decodes in every build this app supports, so this is an instrument fault ' +
      '(stale Electron, empty allowedMedia, or a broken build), not a measurement. ' +
      'No table printed.',
    )
  }

  console.log('\ncontainer      canPlayType        <video> decode')
  console.log('-------------  -----------------  --------------')
  for (const { label, guess, outcome } of rows) {
    console.log(`${label.padEnd(13)}  ${guess.padEnd(17)}  ${outcome}`)
  }
} catch (error) {
  problems.push(String(error))
  console.log(`probe failed: ${String(error)}`)
} finally {
  page?.close()
  // Kill and *confirm*. A leaked process holds the debugging port and silently
  // hijacks the next run — which is how the uniformly-failing table in the
  // header came about. Killing without waiting is what allowed it.
  if (electron !== null && electron.exitCode === null) {
    // Negative pid: the whole process group, so the real Electron behind the
    // shim goes with it. Falls back to the plain handle if the group is already
    // gone, which throws ESRCH rather than returning quietly.
    try {
      process.kill(-electron.pid, 'SIGKILL')
    } catch {
      electron.kill('SIGKILL')
    }
    // A signal-killed child reports `signalCode`, not `exitCode` — `exitCode`
    // stays null forever, so waiting on it alone warns on every clean teardown.
    const gone = () => electron.exitCode !== null || electron.signalCode !== null
    for (let attempt = 0; attempt < 40 && !gone(); attempt++) await sleep(50)
    if (!gone()) {
      // Fatal, not cosmetic: this process keeps the debugging port and the next
      // run will attach to it and measure its stale `allowedMedia`.
      problems.push(
        `Electron pid ${electron.pid} did not exit — it will hijack the next run. ` +
        `Kill it first: lsof -ti :${DEBUG_PORT} | xargs kill -9`)
    }
  }
  rmSync(workspace, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.log(`\nPROBE UNUSABLE — ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
  console.log('Any table above is not a measurement. Do not copy it into mediaFormats.ts.')
} else {
  console.log('\nProbe complete. Positive control passed, no process leaked.')
}
process.exit(problems.length === 0 ? 0 : 1)
