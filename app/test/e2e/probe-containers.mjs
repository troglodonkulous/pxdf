/**
 * Which media containers does this Electron build actually decode, and what
 * `Content-Type` does `pxdf-media://` serve each of them as?
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
 * through `pxdf-media://` in the running app. The distinction it can draw and the
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
 * table, so the script clicks Add cue with `PXDF_PICK_MEDIA` seeded first.
 *
 * The route to that click is not fixed and this script does not get to assume
 * it. The app launches on the Mapping surface; the cue stack is behind `Open
 * Player`; and the `+` grew a menu whose `Upload` item is what now opens the
 * picker. All three moved after this script was first written, and its next run
 * stopped dead at "the Add cue button never appeared" — which is the polling
 * guard below working, not a finding about containers. Every step is polled for
 * and every failure names the step it is.
 *
 * ## The second question, added 2026-09-18
 *
 * The handler used to fetch bytes with `net.fetch` over a `file://` URL and
 * pass that response's headers through, so Chromium's own extension-to-MIME
 * table named the type and nothing in this repo had to. Serving a byte range
 * means building the `Response` from a raw `createReadStream`, which carries no
 * headers at all, so `src/player/mediaFormats.ts` now names the type itself —
 * and of the five extensions the picker offers, only `mp4`/`m4v` had ever been
 * watched come back `video/mp4`. `mov`, `webm` and `mkv` were reasoned from
 * what the standard types for those containers are. Every clip the `wire.mjs`
 * gate plays is an `.mp4`, so nothing else in the repo could have caught a
 * wrong one.
 *
 * So each row now also `fetch`es its own `pxdf-media://` URL from inside the
 * page and records `response.headers.get('Content-Type')`. `fetch` and not the
 * `<video>` element, because an element exposes no response headers at all —
 * this is the only way to see what the handler actually said. The two halves
 * are independent on purpose: a container can decode while carrying a label
 * nobody intended, because `<video src=…>` does not gate on the declared type,
 * and a table that printed only the decode verdict would show that as a pass.
 *
 * ## The positive control, and why it exists
 *
 * `mp4` must decode, **and must come back `video/mp4`**. If either fails, the
 * instrument is broken and every other row is meaningless — so the script
 * refuses to print a table at all rather than printing one where everything
 * failed. `video/mp4` is the right thing to pin it to because it is
 * corroborated by something outside this script: Chromium's own extension table
 * in the shipped binary carries the entry `mp4,m4v` against `video/mp4`, and
 * `wire.mjs` read that same answer back through the pre-range handler.
 *
 * Coverage is checked as well as correctness. The table exists to supply a
 * value for each of the five extensions the picker offers, so if ffmpeg could
 * not author one of them, or a row went missing between authoring and
 * measuring, the run refuses rather than printing a table that looks complete
 * and is silently short a container. A probe that measured nothing must not
 * read as a probe that found nothing wrong.
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
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
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

/**
 * The extensions the picker offers, read out of the file this probe feeds.
 *
 * Read rather than repeated, because a copy here would be a second list that
 * drifts from the first in silence — and what it would look like when it drifts
 * is a probe that measures four of five containers and prints a table with no
 * gap in it. A parse failure throws; it is an instrument fault, not a finding.
 */
function pickerExtensions() {
  const source = readFileSync(resolve(APP_DIR, 'src', 'player', 'mediaFormats.ts'), 'utf8')
  const literal = /PICKER_EXTENSIONS[^=]*=\s*\[([^\]]*)\]/.exec(source)
  if (literal === null) throw new Error('could not find PICKER_EXTENSIONS in src/player/mediaFormats.ts')
  const found = [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  if (found.length === 0) throw new Error('PICKER_EXTENSIONS parsed as empty — the probe cannot know what to cover')
  return found
}

/** Click the first button whose trimmed text starts with a string. Throws if there is none. */
const clickButton = (text) => `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (button === undefined) throw new Error('no button labelled ${text}')
  button.click()
  return true
})()`

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

const workspace = mkdtempSync(join(tmpdir(), 'pxdf-probe-'))
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
/**
 * Things the table itself says, that a reader must act on.
 *
 * Kept apart from `problems` because they mean opposite things about the run: a
 * problem says do not believe the table, a regression says believe it and look
 * at this row. Both make the exit non-zero; conflating them would either
 * discard a real finding or tell a reader to throw away a sound measurement.
 */
const regressions = []

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
        PXDF_ADDRESS: '127.0.0.1',
        PXDF_PORT: String(SIDECAR_PORT),
        PXDF_PICK_MEDIA: made.map((entry) => entry.path).join(delimiter),
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
  //
  // And a mounted page is not a reachable picker: the app launches on Mapping,
  // the cue stack is behind `Open Player`, and the `+` opens a menu rather than
  // the picker. Each of those is polled for separately so that a failure names
  // the step that failed instead of blaming the last one in the chain.
  const waitFor = async (expression, complaint) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await page.evaluate(expression)
      if (value) return value
      await sleep(200)
    }
    throw new Error(complaint)
  }

  await waitFor('document.querySelector(".mapping-screen") !== null',
    'the app never mounted its Mapping surface')
  await page.evaluate(clickButton('Open Player'))
  await waitFor('document.querySelector(".play-screen") !== null',
    'Open Player never reached the Play surface')
  await waitFor('document.querySelector(\'[aria-label="Add cue"]\') !== null',
    'the Add cue button never appeared — the page did not mount')

  // Populate `allowedMedia` through the real picker seam. Without this every
  // row below reads 403 and the table is uniformly, wrongly, "fails".
  await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
  await waitFor('document.querySelectorAll(\'[role="menuitem"]\').length > 0',
    'the + menu never opened, so the picker was never reachable')
  await page.evaluate(clickButton('Upload'))

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
    const url = `pxdf-media://file${path.split('/').map(encodeURIComponent).join('/')}`
    // One evaluate, two independent measurements of the same URL.
    //
    // The `fetch` is what reads the handler's own answer: a `<video>` element
    // exposes no response headers, so the type it was handed is invisible from
    // the element side. Its failures are caught and returned as the cell value
    // rather than thrown, because a row that could not be served is a fact
    // about that row and belongs in the table where it can be read — the
    // control below is what decides whether the table is worth printing at all.
    const result = await page.evaluate(`
      (async () => {
        const url = ${JSON.stringify(url)}
        let served
        try {
          const response = await fetch(url)
          served = response.ok
            ? (response.headers.get('Content-Type') ?? '(no Content-Type)')
            : 'HTTP ' + response.status
        } catch (error) {
          served = 'fetch threw: ' + String(error)
        }
        const decode = await new Promise((done) => {
          const v = document.createElement('video')
          v.muted = true
          v.crossOrigin = 'anonymous'
          v.addEventListener('loadeddata', () => done('DECODES'))
          v.addEventListener('error', () => done('fails: ' + (v.error?.message ?? v.error?.code)))
          setTimeout(() => done('fails: timeout'), 5000)
          v.src = url
          v.load()
        })
        const probeElement = document.createElement('video')
        const guess = probeElement.canPlayType(${JSON.stringify(mimeFor(label))}) || 'no'
        return { served, decode, guess }
      })()
    `)
    if (result === undefined || typeof result.served !== 'string') {
      throw new Error(`the page returned no measurement for ${label}: ${JSON.stringify(result)}`)
    }
    return { label, ...result }
  }

  const rows = []
  for (const entry of made) rows.push(await probe(entry))

  // Counts first, and before anything is printed. A run that measured nothing
  // must not read as a run that found nothing wrong, and a table silently short
  // one container looks exactly as complete as a full one.
  if (rows.length === 0) throw new Error('no container was measured at all — no table printed')
  if (rows.length !== made.length) {
    throw new Error(`authored ${made.length} clips but measured ${rows.length} — no table printed`)
  }

  // The positive control. See the header: a table in which everything failed is
  // what a leaked-process or 403 fault looks like, and it is indistinguishable
  // from a finding unless something that must pass is checked first. Both
  // halves, because the two fail independently — an `mp4` that decodes while
  // carrying a label nobody intended is exactly what this run was added to
  // catch, and `<video>` will not notice it.
  const control = rows.find((row) => row.label === 'mp4')
  if (control === undefined || control.decode !== 'DECODES' || control.served !== 'video/mp4') {
    throw new Error(
      `positive control failed: mp4 decoded "${control?.decode ?? 'missing'}" and was served ` +
      `"${control?.served ?? 'missing'}", wanted DECODES and video/mp4. Both are corroborated ` +
      "outside this script — Chromium's own extension table in the shipped binary carries " +
      'mp4,m4v against video/mp4 — so this is an instrument fault (stale Electron, empty ' +
      'allowedMedia, or a broken build), not a measurement. No table printed.',
    )
  }

  // Coverage. The table exists to supply a value for each extension the picker
  // offers; one that never got measured is a hole the printed table cannot show.
  const wanted = pickerExtensions()
  const missing = wanted.filter((extension) => !rows.some((row) => row.label === extension))
  if (missing.length > 0) {
    throw new Error(
      `no measurement for ${missing.join(', ')}, which the picker offers — probably an ffmpeg ` +
      'without the encoder for it (see the SKIP lines above). The table would read as complete ' +
      'while saying nothing about those containers. No table printed.',
    )
  }

  // Width from the data, not a constant. A `Content-Type` longer than the
  // column pushes the decode verdict out of alignment, and a misaligned table
  // is the one thing a reader skims past — this is the output that gets copied
  // into `mediaFormats.ts` by eye.
  const typeWidth = Math.max('served Content-Type'.length, ...rows.map((row) => row.served.length))
  console.log(`\ncontainer      canPlayType        ${'served Content-Type'.padEnd(typeWidth)}  <video> decode`)
  console.log(`-------------  -----------------  ${'-'.repeat(typeWidth)}  --------------`)
  for (const { label, guess, served, decode } of rows) {
    console.log(`${label.padEnd(13)}  ${guess.padEnd(17)}  ${served.padEnd(typeWidth)}  ${decode}`)
  }
  // Said out loud because it otherwise reads as a defect. Only the extensions
  // in `PICKER_EXTENSIONS` have an entry in `MEDIA_CONTENT_TYPES`; every other
  // row here is the deliberate `application/octet-stream` fallback, reached
  // only because this script pushes files through the picker seam that the
  // picker's own filter would never offer.
  console.log(`\nPicker containers: ${wanted.join(' · ')}. `
    + 'Every other row is served the application/octet-stream fallback by design.')

  // Failures in the picker's own five, found by a run whose instrument checked
  // out. Not "probe unusable" — the table above is a measurement and stands.
  // Recorded separately so the exit is still non-zero and `probe && next-thing`
  // cannot sail past a container the app offers and can no longer play.
  for (const row of rows.filter((candidate) => wanted.includes(candidate.label))) {
    if (row.decode !== 'DECODES') {
      regressions.push(`${row.label} is offered by the picker and did not decode: ${row.decode}`)
    }
    if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(row.served)) {
      regressions.push(`${row.label} was not served a media type at all: ${row.served}`)
    }
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
} else if (regressions.length > 0) {
  console.log(`\nTABLE STANDS, BUT ${regressions.length} PICKER CONTAINER(S) FAILED:\n  - ${regressions.join('\n  - ')}`)
  console.log('The instrument checked out, so these are findings. Fix mediaFormats.ts or the handler.')
} else {
  console.log('\nProbe complete. Positive control passed, all picker containers measured, no process leaked.')
}
process.exit(problems.length === 0 && regressions.length === 0 ? 0 : 1)
