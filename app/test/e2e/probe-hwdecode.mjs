/**
 * Is `PIPELINE_ERROR_DECODE` coming from the hardware decoder?
 *
 * **A measurement, not a gate.** Nothing runs it automatically.
 *
 *     node test/e2e/probe-hwdecode.mjs           # needs `npm run build` first
 *     ROUNDS=5 node test/e2e/probe-hwdecode.mjs
 *
 * ## Why this exists
 *
 * `probe-decoder-load.mjs`, pointed at `test-patterns/Test Clips 3/` on
 * 2026-09-03, produced the floor's error — `PipelineStatus::PIPELINE_ERROR_DECODE`
 * — **in its serial arm**, which loads one clip at a time. Concurrency exactly
 * one. Four runs, one to two failures per twelve clips, and a *different* subset
 * failing each run. That killed the concurrency explanation and strained the
 * range-request one: a single serial load of a 5 MB file served whole has no
 * memory pressure and nothing to evict.
 *
 * What it leaves is a decoder that intermittently fails on media a second,
 * independent decoder handles perfectly: `ffmpeg -f null` decodes all twelve
 * files end to end with zero errors. ffmpeg there is software; Chromium on this
 * machine is VideoToolbox. All twelve clips are HEVC. That is a hardware-decode
 * signature, and this probe is the channel for it.
 *
 * ## The two arms
 *
 * Same clips, same loader, one Electron process each, differing in one switch:
 *
 * 1. **default** — whatever Chromium picks, which is VideoToolbox here.
 * 2. **`--disable-accelerated-video-decode`** — software decode.
 *
 * **Measured 2026-09-03: on HEVC the second arm cannot answer the question.**
 * With acceleration off, Chromium returns `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`
 * for most of these clips — it ships no software HEVC decoder, so the arm
 * reports codec support and not decode reliability. Counting those as decode
 * failures makes hardware and software look equally bad and retires a live
 * theory on the strength of the instrument's blind spot, which is what the
 * first version of the verdict block did. It now names the case instead. Run
 * `ARMS=hardware` to skip the arm entirely and halve the runtime.
 *
 * The comparison is still the right one for H.264 media, which is why the arm
 * stays.
 *
 * ## What it also controls for
 *
 * `probe-decoder-load.mjs` runs its serial arm *after* its app-path arm, in the
 * same page, so a dozen throwaway decoders have already come and gone by then
 * and a cue may be live. "Serial" there means serially loaded, not a clean
 * process. This probe loads nothing else, drives no UI, and gets a fresh
 * Electron per arm — so a failure here cannot be residue from earlier work.
 *
 * ## Positive control
 *
 * The instrument's own failure mode is measuring nothing: a page that never
 * mounts, a clip directory that is empty, a `pxdf-media://` that 403s every
 * request would each produce a tidy table of failures that says "the decoder is
 * broken" when the truth is "the probe is".
 *
 * So **every arm decodes an H.264 control clip before it measures anything**,
 * and an arm that cannot prints no column and fails the run. It is per-arm
 * because the first version was per-run — it refused only when every load
 * failed in both arms, which let one healthy arm conceal a completely broken
 * one. And it is H.264 because the measured set is HEVC: a software arm is
 * *expected* to refuse HEVC on this build, so an HEVC control could never tell
 * a broken arm from an unsupported codec.
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * One port per arm, not one port reused.
 *
 * Not 9333 (wire), 9334 (containers) or 9335 (decoder-load), so all of them can
 * run together. The two arms take two ports because sharing one is a silent
 * failure with the worst possible shape: if the first arm's Electron survives
 * its `SIGKILL` — a stuck renderer, a slow group teardown — the second arm's
 * attach loop finds *its* debuggable page still listening, attaches, and
 * measures the hardware process a second time while printing the numbers in a
 * column headed "software". Every clip would agree with itself and the run
 * would look like a clean negative result. Two ports make that impossible, and
 * the stale check below refuses rather than measures if either is occupied.
 */
const DEBUG_PORTS = { hardware: 9_336, software: 9_337 }
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const CLIP_DIR = process.env.PXDF_CLIP_DIR ?? resolve(APP_DIR, '..', 'test-patterns', 'Test Clips 3')
/** How many times each arm walks the whole clip set. The failure is intermittent; one pass is an anecdote. */
const ROUNDS = Number(process.env.ROUNDS ?? '3')

/** Copied from `PICKER_EXTENSIONS`; see the note in `probe-decoder-load.mjs`. */
const PICKER_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv']
const skipped = []
const CLIPS = readdirSync(CLIP_DIR).sort().filter((name) => {
  if (PICKER_EXTENSIONS.includes(extname(name).toLowerCase())) return true
  if (!name.startsWith('.')) skipped.push(name)
  return false
}).map((name) => join(CLIP_DIR, name))

/**
 * The per-arm positive control: one clip that must decode, or the arm reports
 * nothing.
 *
 * H.264 on purpose. The measured set is entirely HEVC, and an arm running with
 * `--disable-accelerated-video-decode` answers HEVC with
 * `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` — so an HEVC control would be *expected*
 * to fail there and could never distinguish "software decode is broken" from
 * "this build has no software HEVC". A clip Chromium can decode by either path
 * separates the arm being alive from the codec being supported, which is the
 * whole job of a control.
 *
 * It also catches what the old whole-run check could not. That one refused only
 * when *every* load failed in *both* arms, so one healthy arm concealed a
 * broken one: an arm whose page never mounted, whose clips never reached
 * `allowedMedia`, or whose media handler 403s everything would post a column of
 * failures that reads as a decoder finding. Each arm now proves itself first.
 *
 * `11-white-8x8_4P-10x5.mp4` is 3 KB, 80×40, 60 white frames. Note it is
 * untracked as of 2026-09-03 — `CLAUDE.md` wants evidence in the repo, so it
 * should be committed if this probe's results are ever cited.
 */
const CONTROL_CLIP = process.env.PXDF_CONTROL_CLIP
  ?? resolve(APP_DIR, '..', 'test-patterns', '11-white-8x8_4P-10x5.mp4')

const mediaUrl = (path) => `pxdf-media://file${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * One clip, loaded and seeked the way `captureThumbnail` does.
 *
 * Deliberately the same shape as `probe-decoder-load.mjs`'s `loadOne` — the
 * whole point is to re-run *that* measurement against a different decoder, and
 * a loader that differed would be measuring two things at once.
 */
const loadOne = (path) => `
  (() => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    const name = (e) => ({1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'}[e?.code] ?? 'unknown')
    return new Promise((done) => {
      // \`settled\` and the cleanup channel, both added 2026-09-03 after review.
      //
      // Tearing the element down fires events — \`load()\` on a cleared \`src\`
      // raises \`error\` — so cleanup can re-enter \`finish\` and, without the
      // guard, a clip that decoded could report the teardown's error instead.
      // \`{ once: true }\` does not help: the listeners are distinct.
      //
      // The \`catch {}\` that used to sit here is the more serious half. This
      // probe's premise is that each load is independent, and that premise is
      // exactly what cleanup enforces: a decoder that survives teardown stays
      // attached to the next clip's load and turns residue into what reads as
      // hardware-decoder evidence. Swallowing that failure kept the premise
      // *stated* while letting it be false. It is now an outcome of its own,
      // and the runner treats it as fatal.
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          v.removeAttribute('src')
          v.load()
        } catch (err) {
          done('CLEANUP FAILED: ' + String(err))
          return
        }
        done(outcome)
      }
      const timer = setTimeout(() => finish('TIMEOUT'), 5000)
      v.addEventListener('error', () => {
        finish(name(v.error) + ': ' + (v.error?.message ?? ''))
      }, { once: true })
      v.addEventListener('loadedmetadata', () => {
        v.addEventListener('seeked', () => {
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
          // A page that threw must never read as a page that answered.
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

/**
 * One arm: a fresh Electron, `ROUNDS` serial passes over every clip.
 *
 * The clips must reach `allowedMedia` or every request 403s, so they go through
 * the `PXDF_PICK_MEDIA` seam the same way the other probes authorize theirs —
 * the picker is never opened, but the paths are the operator's choice as far as
 * `main.ts` is concerned.
 */
async function runArm(label, port, extraArgs) {
  let electron = null
  let page = null
  try {
    // A leaked Electron holding this port is not a stalled run, it is a wrong
    // one: the attach loop below would find its page and measure it happily.
    // Refuse instead. Same rule, and the same reasoning, as
    // `probe-decoder-load.mjs`.
    try {
      const stale = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (stale.ok) {
        throw new Error(`${label}: something is already listening on ${port} — kill it: lsof -ti :${port} | xargs kill -9`)
      }
    } catch (error) {
      if (String(error).includes('already listening')) throw error
      // Connection refused is the good case.
    }

    electron = spawn(
      resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
      [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${port}`, ...extraArgs],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          PXDF_ADDRESS: '127.0.0.1',
          PXDF_PORT: '60004',
          // The control is picked alongside the set so it lands in
          // `allowedMedia` too; it is excluded from the measured columns below.
          PXDF_PICK_MEDIA: [...CLIPS, CONTROL_CLIP].join(':'),
        },
        stdio: 'ignore',
        detached: true,
      },
    )

    for (let attempt = 0; attempt < 100 && page === null; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const target = (await response.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (target !== undefined) page = await openPage(target.webSocketDebuggerUrl)
      } catch {
        // The port is not up yet.
      }
      if (page === null) await sleep(200)
    }
    if (page === null) throw new Error(`${label}: Electron never exposed a debuggable page`)

    // Authorize the clips: `Open Player`, then the picker seam, which puts every
    // picked path into `allowedMedia`. Without this every load is a 403 and the
    // arm measures the media handler rather than the decoder.
    let ready = false
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      ready = await page.evaluate(
        '[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Open Player"))')
      if (!ready) await sleep(200)
    }
    if (!ready) throw new Error(`${label}: the Mapping surface never mounted`)
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
    if (!hasButton) throw new Error(`${label}: the Play surface never mounted`)
    await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
    await page.evaluate(`
      (() => {
        const item = [...document.querySelectorAll('.add-menu [role="menuitem"]')]
          .find((b) => b.textContent.includes('Upload media'))
        if (item === undefined) throw new Error('no Upload media item in the + menu')
        item.click()
      })()
    `)
    const expectedCues = CLIPS.length + 1
    let cueCount = 0
    for (let attempt = 0; attempt < 60 && cueCount < expectedCues; attempt++) {
      cueCount = await page.evaluate('document.querySelectorAll(".cue-row").length')
      if (cueCount < expectedCues) await sleep(200)
    }
    if (cueCount < expectedCues) throw new Error(`${label}: only ${cueCount}/${expectedCues} clips were authorized`)
    // Let the app's own fan-outs finish, so the serial passes below are not
    // racing a dozen thumbnail decoders. That race is what the other probe
    // measures; this one is about the decoder in isolation.
    await sleep(8000)

    // The control, before anything is measured. An arm that cannot decode a
    // 3 KB H.264 clip is not reporting on the media — it is broken, and every
    // number it would go on to print is an artefact of that.
    const control = await page.evaluate(loadOne(CONTROL_CLIP))
    if (control !== 'DECODES') {
      throw new Error(`${label}: positive control ${CONTROL_CLIP.split('/').pop()} did not decode (${control}) — ` +
        'this arm is broken, not the media. No column printed for it.')
    }

    // `failures[clip]` counts, `notes` keeps one verbatim message per distinct error.
    const failures = new Map(CLIPS.map((clip) => [clip, 0]))
    const notes = new Map()
    for (let round = 0; round < ROUNDS; round++) {
      for (const clip of CLIPS) {
        const outcome = await page.evaluate(loadOne(clip))
        // Cleanup failure means the next load may inherit a live decoder, so
        // every measurement after this point is suspect. Stop rather than
        // report them.
        if (outcome.startsWith('CLEANUP FAILED')) {
          throw new Error(`${label}: decoder teardown failed on ${clip.split('/').pop()} (${outcome}) — ` +
            'serial isolation is no longer guaranteed, so the rest of this arm is void.')
        }
        if (outcome === 'DECODES') continue
        failures.set(clip, failures.get(clip) + 1)
        if (!notes.has(outcome)) notes.set(outcome, `${clip.split('/').pop()} (round ${round + 1})`)
      }
    }
    return { label, ran: true, failures, notes, loads: ROUNDS * CLIPS.length }
  } finally {
    page?.close()
    if (electron !== null) {
      try { process.kill(-electron.pid, 'SIGKILL') } catch { electron.kill('SIGKILL') }
    }
    // Each arm has its own port, so this is teardown settling time and not a
    // race being waited out.
    await sleep(1500)
  }
}

const problems = []
try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js missing — run `npm run build` first')
  if (CLIPS.length === 0) throw new Error(`no clips in ${CLIP_DIR} — nothing to measure`)
  if (skipped.length > 0) console.log(`note: not measured: ${skipped.join(', ')}`)
  console.log(`${CLIPS.length} clips from ${CLIP_DIR}, ${ROUNDS} rounds per arm\n`)

  const hardware = await runArm('hardware (default)', DEBUG_PORTS.hardware, [])
  // The software arm costs a second Electron launch and, on HEVC media, answers
  // a question nobody asked — see the verdict block below. `ARMS=hardware`
  // skips it. Its absence is reported rather than left to look like a pass.
  // `ran: false` and not a zero-filled result. A skipped arm used to be a
  // `loads: 0` object, and `total(software) === 0` then satisfied "software
  // decode does not fail" — so `ARMS=hardware` printed a verdict crediting an
  // arm that never launched. An arm that did not run has no failures *and* no
  // successes; conflating those is this file's own subject matter.
  const software = process.env.ARMS === 'hardware'
    ? { label: 'software (not run)', ran: false, failures: new Map(), notes: new Map(), loads: 0 }
    : await runArm('software (--disable-accelerated-video-decode)', DEBUG_PORTS.software, ['--disable-accelerated-video-decode'])

  const total = (arm) => [...arm.failures.values()].reduce((sum, n) => sum + n, 0)
  const cell = (arm, clip) => (arm.ran ? `${arm.failures.get(clip)}/${arm.loads / CLIPS.length}` : '-')

  console.log('clip                                          hardware   software')
  for (const clip of CLIPS) {
    const name = clip.split('/').pop().slice(0, 42).padEnd(44)
    console.log(`${name}${cell(hardware, clip).padStart(6)}${cell(software, clip).padStart(11)}`)
  }
  console.log(`\n${'TOTAL'.padEnd(44)}${(hardware.ran ? `${total(hardware)}/${hardware.loads}` : '-').padStart(6)}` +
    `${(software.ran ? `${total(software)}/${software.loads}` : '-').padStart(11)}`)
  if (!software.ran) console.log('\nsoftware arm: NOT RUN (ARMS=hardware). Its column says nothing either way.')

  for (const arm of [hardware, software]) {
    if (arm.notes.size === 0) continue
    console.log(`\n${arm.label} — distinct errors:`)
    for (const [message, where] of arm.notes) console.log(`  ${message}\n    first seen: ${where}`)
  }

  // The software arm is only a comparison if it decoded the same *kind* of
  // thing. Measured 2026-09-03: with acceleration off, Chromium answers most of
  // these clips with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` — it has no software
  // HEVC decoder, so the arm is reporting codec support and not decode
  // reliability. Counting that as "software fails too" is how this probe would
  // have talked itself out of its own finding: two different errors summed into
  // one number, and a verdict line that read the instrument's blind spot as
  // evidence. Different error, different question, said out loud.
  const unsupported = [...software.notes.keys()].filter((m) => m.includes('NO_SUPPORTED_STREAMS')).length > 0
  if (!hardware.ran || !software.ran) {
    console.log('\nOnly one arm ran, so there is no comparison to make. Read the column that has numbers in it.')
  } else if (unsupported) {
    console.log('\nThe software arm is INVALID as a comparison: it reports DEMUXER_ERROR_NO_SUPPORTED_STREAMS,')
    console.log('which is Chromium having no software HEVC decoder at all, not a decode failure. It says')
    console.log('nothing about whether hardware decode is the axis. Read the hardware column alone.')
  } else if (total(hardware) > 0 && total(software) === 0) {
    console.log('\nHardware decode fails where software decode does not. The decoder is the axis.')
  } else if (total(hardware) === 0 && total(software) === 0) {
    console.log('\nNeither arm failed. This run reproduced nothing — it does not clear the hardware decoder,')
    console.log('it only failed to catch it. Re-run with more ROUNDS before concluding anything.')
  } else if (total(software) > 0) {
    console.log('\nSoftware decode fails too. The decoder is not the axis; look elsewhere.')
  }
} catch (error) {
  console.error(`\nrun failed: ${error}`)
  problems.push(String(error))
} finally {
  if (problems.length > 0) {
    console.error(`\nPROBE UNUSABLE — ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
  }
}
