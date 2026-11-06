/**
 * Does the app's unbounded decoder fan-out actually break anything?
 *
 * **A measurement, not a gate.** Nothing runs it automatically. It exists
 * because a claim was made about this code — that `PlayScreen`'s two fan-outs
 * (`captureThumbnail` per cue, `probeCueDuration` per added cue) spin up enough
 * concurrent decoders to make clips fail — and that claim had no evidence
 * channel behind it. This is the channel. `probe-containers.mjs` is the same
 * shape of instrument for the same reason.
 *
 *     node test/e2e/probe-decoder-load.mjs        # needs `npm run build` first
 *     COPIES=4 node test/e2e/probe-decoder-load.mjs
 *
 * `COPIES` decides how many copies of the six clips go through the picker, so
 * the app-path arm can be walked past the six-clip case without authoring new
 * media. The clips are the six real ones in `test-patterns/Test Clips/`, which
 * is gitignored (~188 MB) — the script refuses rather than measuring nothing if
 * they are not on this machine.
 *
 * ## The three arms
 *
 * 1. **App path, both fan-outs.** Adds the picked clips through the real
 *    `PXDF_PICK_MEDIA` picker seam, then counts the cue rows that ended up with
 *    a thumbnail *and* the cues that ended up with a Duration. Both are
 *    operator-visible consequences of a lost throwaway decoder, and they are
 *    separate channels: `PlayScreen` swallows a thumbnail rejection
 *    (`.catch(() => {})`) into a blank square, and swallows a duration
 *    rejection into `mediaDurationMs: null`, which is an em dash in the
 *    inspector and a Loop that never advances. Grading one would pass a run in
 *    which the other lost every probe. It also reads the error banner.
 * 2. **Serial, then concurrent.** All six loaded through `pxdf-media://` the way
 *    `captureThumbnail` loads them — `crossOrigin`, `src`, `loadedmetadata`,
 *    seek, `drawImage` — reporting the raw `MediaError` name and message rather
 *    than a generic failure. Serial runs first and is the positive control: if
 *    the clips do not decode one at a time, nothing the concurrent arm says
 *    means anything, and no table is printed.
 * 3. **Load walk.** 12, 24 and 48 concurrent decoders with a cue live, which is
 *    well past anything the app does — the app's own worst case is one
 *    throwaway per cue. Deliberately synthetic: it exists to find the ceiling,
 *    not to describe normal use.
 * 4. **The decoder census**, read back out of the app's own heartbeat. The
 *    child is launched with `PXDF_HEARTBEAT_SECONDS=5` and the log is read after
 *    it exits, for the highest `peak=` it recorded — the most decoders the
 *    window held open at once while this run added its cues.
 *
 * ## Why arm 4 exists, and it is the important part of this file
 *
 * Arms 1-3 count *outcomes*, and outcomes here are a race. `captureThumbnail`
 * carries a 5 s deadline that starts when the fan-out creates it, so a
 * thumbnail is lost when its decoder is still queued behind seventy others at
 * the 5 s mark — which depends on how warm the machine is, what is in the OS
 * page cache, and what else is running. On 2026-09-19 that produced 6/71 on a
 * cold library and 43, 43, 63 and 71 out of 71 on four later runs of the *same
 * unbounded build*, because by then the files were all cached. A run of this
 * file against a build with the concurrency limit deliberately removed exited
 * 0. **The outcome arms can pass over a broken build**, and a gate that can do
 * that is the thing `CLAUDE.md` calls a green gate over a broken thing.
 *
 * `peak` cannot. It counts decoders the window held open, not how quickly any
 * of them finished, so it does not move with the page cache: 142 for the
 * unbounded fan-out and 8 for the bounded one, on the same machine, minutes
 * apart. It is graded here rather than merely printed, and graded without
 * naming any limit: the check is that `peak` came in **below the number of
 * cues added**, which no per-cue fan-out can satisfy — an unbounded one reads
 * about 2N — and which any bound that does not scale with N satisfies easily.
 * Nothing here has to be updated when `THROWAWAY_DECODER_LIMIT` changes.
 *
 * It is graded only at 32 cues or more. Below that, 2N is small enough that an
 * unbounded fan-out would pass the check, so the run prints the number and
 * says it did not grade it rather than reporting a pass it did not earn. The
 * six-clip default corpus is always in that case.
 *
 * ## One cost, stated
 *
 * The log this reads is `~/Library/Logs/Electron/pxdf.log`, the same file
 * `wire.mjs` grades, and launching Electron rotates it. That was already true
 * of this probe before it read the file — any run of this rotates the log out
 * from under a concurrent `wire.mjs` — but it is worth saying now that it
 * matters to this file too: **do not run the two at the same time**, whatever
 * the debug ports allow.
 *
 * ## Measured 2026-08-15, Electron 43.4.0, macOS, five runs
 *
 *   app path, 6 clips        6/6 thumbnails, 1.29-1.65 s, no banner
 *                            6/6 Durations, matching ffprobe to the second
 *   app path, 24 clips       24/24 thumbnails, 2.49-2.81 s, no banner
 *                            24/24 Durations
 *   serial arm               6/6 DECODES, every run
 *   concurrent arm           6/6 DECODES, every run
 *   12 / 24 / 48 decoders    all decode in 3 runs of 5; in the other 2,
 *                            `PixelSquare_05.mov` alone timed out at 5 s
 *
 * No `MEDIA_ERR_DECODE` and no `MEDIA_ERR_SRC_NOT_SUPPORTED` was produced by
 * concurrency at any width. The one failure the instrument can produce is a
 * timeout, it is confined to the 171 MB clip, and it appears only in the
 * synthetic arms and only when that file is not already in the OS page cache —
 * the app arm loads it first, which is why the app arm never sees it. So the
 * exit code grades the app arm alone. The load walk is reported and not graded:
 * a check that fires on 2 runs in 5 is a channel that cries wolf, and this
 * project has a rule about those.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, delimiter, join, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** Not 9334 (probe-containers) and not the wire gate's, so all three can run together. */
const DEBUG_PORT = 9_335
const SIDECAR_PORT = 60_003
const APP_DIR = resolve(import.meta.dirname, '..', '..')
/**
 * `Test Clips/` is gitignored, so a git worktree of this branch does not have
 * it — only the checkout it was downloaded into does. `PXDF_CLIP_DIR` points
 * this at that checkout rather than making the probe unrunnable off the main
 * clone.
 */
const CLIP_DIR = process.env.PXDF_CLIP_DIR ?? resolve(APP_DIR, '..', 'test-patterns', 'Test Clips')

/**
 * The default six, named rather than globbed so the 2026-08-15 measurement
 * above stays re-runnable against exactly the media it was taken on.
 */
const DEFAULT_CLIPS = [
  'abstract-glowing-gradient-circle-round-animation-2022-08-19-06-22-36-utc.mp4',
  'AdobeStock_273498870.mov',
  'colorful-stage-lighting-background-loop-2022-05-23-02-15-18-utc.mp4',
  'Pexels Videos 4562.mp4',
  'PixelSquare_05.mov',
  'red_-_108070 (Original).mp4',
]

/**
 * A pointed `PXDF_CLIP_DIR` measures whatever is in that directory, not the six
 * names above.
 *
 * The names were the whole of clip selection until 2026-09-03, and that made
 * the probe unable to measure the media it was most needed on: the twelve
 * clips in `test-patterns/Test Clips 3/` are the ones that produced
 * `MEDIA_ERR_DECODE` on the floor, and pointing the old `PXDF_CLIP_DIR` at them
 * resolved six paths that do not exist there. The probe would have refused —
 * loudly, which is the one thing that stopped it becoming a measurement of the
 * wrong files — but "refuses on the media that matters" and "measures it" are
 * different capabilities, and it had the first one.
 *
 * Sorted, so a run is reproducible and two runs are comparable. Extensions are
 * the picker's, because a directory holding a README should not turn into a
 * clip that fails to decode.
 *
 * `PICKER_EXTENSIONS` lives in `src/player/mediaFormats.ts` and cannot be
 * imported here — this is plain `.mjs`, run by `node` with no TypeScript step —
 * so it is copied, and a copy of a list drifts. The drift matters in one
 * direction only: an extension the picker gained and this list did not is a
 * clip the operator put in the directory and the probe quietly did not measure,
 * which is a smaller clip set reported as a complete run. So skipped files are
 * named rather than dropped. A `README.md` in there is noise worth reading past;
 * a `.mkv` in there is the probe telling you this list is stale.
 */
const PICKER_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv']
const skippedFiles = []
const clipNames = process.env.PXDF_CLIP_DIR === undefined
  ? DEFAULT_CLIPS
  : readdirSync(CLIP_DIR).sort().filter((name) => {
    if (PICKER_EXTENSIONS.includes(extname(name).toLowerCase())) return true
    if (!name.startsWith('.')) skippedFiles.push(name)
    return false
  })
const CLIPS = clipNames.map((name) => join(CLIP_DIR, name))

/** How many copies of the clip set to hand the picker. 1 = the set itself. */
const COPIES = Number(process.env.COPIES ?? '1')
const PICKED = Array.from({ length: COPIES }, () => CLIPS).flat()

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
          const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
          // A page that threw must never read as a page that answered — the
          // failure `probe-containers.mjs` documents, where a click script that
          // threw returned `undefined` and the run carried on measuring nothing.
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

const mediaUrl = (path) => `pxdf-media://file${path.split('/').map(encodeURIComponent).join('/')}`

/** One clip, loaded and seeked the way `captureThumbnail` does, error kept. */
const loadOne = (path) => `
  (() => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    const name = (e) => ({1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'}[e?.code] ?? 'unknown')
    return new Promise((done) => {
      const finish = (outcome) => { try { v.removeAttribute('src'); v.load() } catch {} ; done(outcome) }
      const timer = setTimeout(() => finish('TIMEOUT after 5000ms'), 5000)
      v.addEventListener('error', () => {
        clearTimeout(timer)
        finish(name(v.error) + ' (code ' + (v.error?.code ?? '?') + '): ' + (v.error?.message ?? ''))
      }, { once: true })
      v.addEventListener('loadedmetadata', () => {
        v.addEventListener('seeked', () => {
          clearTimeout(timer)
          try {
            const c = document.createElement('canvas')
            c.width = 40; c.height = 24
            c.getContext('2d').drawImage(v, 0, 0, 40, 24)
            finish('DECODES')
          } catch (err) { finish('draw failed: ' + String(err)) }
        }, { once: true })
        v.currentTime = 0
      }, { once: true })
      v.src = ${JSON.stringify('URL_PLACEHOLDER')}
      v.load()
    })
  })()
`.replace('"URL_PLACEHOLDER"', JSON.stringify(mediaUrl(path)))

let electron = null
let page = null
/** Anything that makes the numbers above untrustworthy, or the next run. */
const problems = []
/** Set once the child has been launched, so a run that never got that far does not grade a stale log. */
let censusExpected = false

try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js missing — run `npm run build` first')
  // An empty clip set is the silent pass this whole file is written against:
  // zero clips picked means zero cue rows expected, so every count check below
  // compares 0 against 0 and the probe reports success having decoded nothing.
  if (CLIPS.length === 0) throw new Error(`no clips in ${CLIP_DIR} — nothing to measure`)
  if (skippedFiles.length > 0) {
    console.log(`note: ${skippedFiles.length} file(s) in ${CLIP_DIR} were not measured: ${skippedFiles.join(', ')}`)
  }
  for (const clip of CLIPS) {
    if (!existsSync(clip)) {
      throw new Error(`clip missing: ${clip} — "Test Clips/" is gitignored (~188 MB) and is not on this machine`)
    }
  }

  // A leaked Electron from a previous run holds this port, and attaching to it
  // would measure its stale `allowedMedia` — every clip 403, which reads as a
  // decoder failure. Refuse instead.
  try {
    const stale = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    if (stale.ok) {
      throw new Error(`something is already listening on ${DEBUG_PORT} — kill it: lsof -ti :${DEBUG_PORT} | xargs kill -9`)
    }
  } catch (error) {
    if (String(error).includes('already listening')) throw error
    // Connection refused is the good case.
  }

  /**
   * The child's environment, with `PXDF_CUE_SEED` taken out rather than assumed
   * absent.
   *
   * The Duration arm below reads `clipDurationMs`, which is
   * `(trimEndMs ?? mediaDurationMs) - trimStartMs`. A seeded `trimEndMs` makes
   * that readout a number no matter what the duration probe did — so an
   * inherited `PXDF_CUE_SEED`, from a shell where the wire gate was being
   * driven by hand, would turn the check into one that cannot fail while still
   * printing timecodes that look like measurements. Clearing it is what makes
   * the arm's premise true; the previous version only stated it in a comment.
   */
  const childEnv = {
    ...process.env,
    PXDF_ADDRESS: '127.0.0.1',
    PXDF_PORT: String(SIDECAR_PORT),
    PXDF_PICK_MEDIA: PICKED.join(delimiter),
    // Set, not inherited. The census arm needs a heartbeat to have landed
    // *after* the fan-out peaked, and the default is one a minute — a run
    // shorter than that would read no census at all and have to say so.
    PXDF_HEARTBEAT_SECONDS: '5',
  }
  if (childEnv.PXDF_CUE_SEED !== undefined) {
    // Said out loud: a run that silently ignored something the operator set is
    // its own small silent failure.
    console.log('note: PXDF_CUE_SEED was set in this shell and is cleared for the probe — ' +
      'a seeded trimEndMs would make the Duration check unable to fail')
    delete childEnv.PXDF_CUE_SEED
  }

  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`],
    {
      cwd: APP_DIR,
      env: childEnv,
      stdio: 'ignore',
      // The `.bin/electron` shim spawns the real binary as its own child, so
      // own the group and teardown can take the whole tree.
      detached: true,
    },
  )

  // Past this point the child has been launched, so it has rotated the old
  // `pxdf.log` away and whatever is in that file now belongs to this run. Set
  // here and not in the `finally`: a run that threw before the spawn — no
  // build, a port already held — would otherwise grade the previous run's
  // census and call it this one's.
  censusExpected = true

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

  // The app launches on Mapping; Play is one click in. Poll for the button
  // rather than assuming React has mounted — clicking before it exists throws,
  // and a run that measured an empty page is what a finding looks like.
  let onMapping = false
  for (let attempt = 0; attempt < 50 && !onMapping; attempt++) {
    onMapping = await page.evaluate(
      '[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Open Player"))')
    if (!onMapping) await sleep(200)
  }
  if (!onMapping) throw new Error('the Mapping surface never mounted')
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Open Player'))
    if (button === undefined) throw new Error('no Open Player button')
    button.click()
  })()`)

  let hasButton = false
  for (let attempt = 0; attempt < 50 && !hasButton; attempt++) {
    hasButton = await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\') !== null')
    if (!hasButton) await sleep(200)
  }
  if (!hasButton) throw new Error('the Add cue button never appeared — the Play surface did not mount')

  const started = Date.now()
  await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
  await page.evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.add-menu [role="menuitem"]')]
        .find((b) => b.textContent.includes('Upload media'))
      if (item === undefined) throw new Error('no Upload media item in the + menu')
      item.click()
    })()
  `)

  let cueCount = 0
  for (let attempt = 0; attempt < 60 && cueCount < PICKED.length; attempt++) {
    cueCount = await page.evaluate('document.querySelectorAll(".cue-row").length')
    if (cueCount < PICKED.length) await sleep(200)
  }
  if (cueCount < PICKED.length) throw new Error(`only ${cueCount} of ${PICKED.length} clips reached the cue stack`)

  // Both fan-outs carry a 5 s deadline, so wait past it before concluding a
  // thumbnail is never coming.
  let thumbs = 0
  let allThumbsMs = null
  for (let attempt = 0; attempt < 90; attempt++) {
    thumbs = await page.evaluate('document.querySelectorAll(".cue-thumb img").length')
    if (thumbs >= PICKED.length) { allThumbsMs = Date.now() - started; break }
    await sleep(250)
  }
  const banner = await page.evaluate('document.querySelector(".error-banner")?.textContent ?? ""')

  /**
   * The second fan-out. `probeCueDuration` is fired per added cue exactly as
   * `captureThumbnail` is, and it fails even more quietly: a rejected probe
   * leaves `mediaDurationMs: null` and nothing is logged at all. Grading
   * thumbnails alone would pass a run in which every duration probe died --
   * the `allBlack([])` shape, a fan-out with no channel -- and the consequence
   * is not cosmetic: `clipDurationMs` null makes `cueHoldMs` null, which the
   * engine reads as "never advance", so a Loop set on that cue does nothing.
   *
   * The inspector's Duration readout is that null, rendered: `PXDF_CUE_SEED` is
   * cleared from the child's environment above, so `trimEndMs` is null and
   * `trimStartMs` is 0, and the readout is an em dash exactly when the probe
   * did not land. Selecting a cue is how the operator reads it, so the probe
   * selects each one and reads it.
   */
  const durations = []
  for (let index = 0; index < PICKED.length; index++) {
    await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.cue-row')]
      if (rows[${index}] === undefined) throw new Error('no cue row ${index}')
      rows[${index}].click()
    })()`)
    let readout = '—'
    // Poll: React republishes on its own tick, and a probe still in flight is
    // not the same as one that failed.
    for (let attempt = 0; attempt < 40; attempt++) {
      readout = await page.evaluate('document.querySelector(".cue-duration-readout")?.textContent?.trim() ?? "(absent)"')
      if (readout !== '—') break
      await sleep(250)
    }
    durations.push(readout)
  }
  const measured = durations.filter((readout) => readout !== '—' && readout !== '(absent)').length

  console.log(`\napp path: ${thumbs}/${PICKED.length} cue rows show a thumbnail` +
    (allThumbsMs === null ? ' (never reached them all)' : ` after ${allThumbsMs} ms`))
  console.log(`          ${measured}/${PICKED.length} cues show a Duration: ${JSON.stringify(durations)}`)
  console.log(`banner:   ${banner === '' ? '(none)' : JSON.stringify(banner)}`)
  if (thumbs < PICKED.length) {
    problems.push(`${PICKED.length - thumbs} of ${PICKED.length} thumbnails never arrived — the fan-out lost decoders`)
  }
  if (measured < PICKED.length) {
    problems.push(
      `${PICKED.length - measured} of ${PICKED.length} cues have no Duration — the duration fan-out lost probes, ` +
      'and Loop on those cues will never advance')
  }

  // Serial first: it is the positive control.
  const serial = []
  for (const clip of CLIPS) serial.push(await page.evaluate(loadOne(clip)))

  const decoded = serial.filter((outcome) => outcome === 'DECODES').length
  if (decoded !== CLIPS.length) {
    console.log('\nserial arm:')
    for (let i = 0; i < CLIPS.length; i++) console.log(`  ${CLIPS[i].split('/').pop().slice(0, 42).padEnd(44)}${serial[i]}`)
    throw new Error(
      `positive control failed: only ${decoded}/${CLIPS.length} clips decode one at a time. That is a clip, ` +
      'allowlist or instrument fault, not concurrency. No comparison printed.')
  }

  const concurrent = await page.evaluate(`Promise.all([${CLIPS.map((c) => loadOne(c)).join(',')}])`)

  console.log('\nclip                                        serial      concurrent')
  console.log('------------------------------------------  ----------  ----------')
  for (let i = 0; i < CLIPS.length; i++) {
    console.log(`${CLIPS[i].split('/').pop().slice(0, 42).padEnd(42)}  ${String(serial[i]).padEnd(10)}  ${concurrent[i]}`)
  }

  // The load walk, with a cue live so the live decoder is in the mix too.
  await page.evaluate(`(() => {
    const go = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'GO')
    if (go !== undefined && !go.disabled) go.click()
  })()`)
  await sleep(1_000)
  console.log('')
  for (const multiple of [2, 4, 8]) {
    const batch = []
    for (let copy = 0; copy < multiple; copy++) batch.push(...CLIPS)
    const outcomes = await page.evaluate(`Promise.all([${batch.map((c) => loadOne(c)).join(',')}])`)
    const bad = outcomes
      .map((outcome, i) => [batch[i].split('/').pop(), outcome])
      .filter(([, outcome]) => outcome !== 'DECODES')
    console.log(`${String(batch.length).padStart(3)} concurrent decoders, cue live: ` +
      `${outcomes.length - bad.length}/${outcomes.length} decode` +
      (bad.length === 0 ? '' : ` — ${JSON.stringify([...new Set(bad.map(([n, o]) => `${n.slice(0, 24)}: ${o}`))])}`))
  }
} catch (error) {
  problems.push(String(error))
  console.log(`run failed: ${String(error)}`)
} finally {
  page?.close()
  if (electron !== null && electron.exitCode === null) {
    try {
      process.kill(-electron.pid, 'SIGKILL')
    } catch {
      electron.kill('SIGKILL')
    }
    // A signal-killed child reports `signalCode` and leaves `exitCode` null
    // forever, so waiting on `exitCode` alone warns on every clean teardown.
    const gone = () => electron.exitCode !== null || electron.signalCode !== null
    for (let attempt = 0; attempt < 40 && !gone(); attempt++) await sleep(50)
    if (!gone()) {
      problems.push(`Electron pid ${electron.pid} did not exit — it will hijack the next run. ` +
        `Kill it: lsof -ti :${DEBUG_PORT} | xargs kill -9`)
    }
  }
}

/**
 * Arm 4. Read after the child is gone, so the log is complete and nothing is
 * still appending to it.
 *
 * An absent census is pushed as a problem rather than skipped. A run that was
 * going to grade the bound and then could not find the file it grades it from
 * has not graded anything, and "no census line" and "a census line reading 8"
 * must not both come out as a clean exit.
 */
if (censusExpected) {
  const logPath = join(homedir(), 'Library', 'Logs', 'Electron', 'pxdf.log')
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const peaks = [...logText.matchAll(/\bpeak=(\d+)/g)].map((match) => Number(match[1]))
  const opened = [...logText.matchAll(/\bopened=(\d+)/g)].map((match) => Number(match[1]))

  if (peaks.length === 0) {
    problems.push(`the heartbeat recorded no decoder census in ${logPath} — the bound was not graded, ` +
      'and an ungraded bound must not read as a held one')
  } else {
    const peak = Math.max(...peaks)
    const totalOpened = opened.length === 0 ? null : Math.max(...opened)
    console.log(`\ncensus:   peak=${peak} decoders held at once` +
      (totalOpened === null ? '' : `, opened=${totalOpened} over the run`) +
      ` · ${PICKED.length} cues added, so an unbounded per-cue fan-out reads about ${PICKED.length * 2}`)
    // Graded without naming a limit — see the header. Only where 2N is large
    // enough that an unbounded fan-out could not slip under the bar.
    if (PICKED.length < 32) {
      console.log(`          not graded: ${PICKED.length} cues is too few for this check to tell the two apart`)
    } else if (peak >= PICKED.length) {
      problems.push(`the window held ${peak} decoders open at once for ${PICKED.length} cues — ` +
        'that is a fan-out with no limit on it, whatever the thumbnail count above says')
    }
  }
}

if (problems.length > 0) {
  console.log(`\nPROBE UNUSABLE OR CONTRADICTED — ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
} else {
  console.log('\nProbe complete. Positive control passed, the app path lost no thumbnails and no durations, ' +
    'no process leaked.')
}
process.exit(problems.length === 0 ? 0 : 1)
