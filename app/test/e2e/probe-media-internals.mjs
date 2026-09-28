/**
 * What does Chromium's own media pipeline say about the `PIPELINE_ERROR_DECODE`
 * failures, at the moment one happens?
 *
 * **A measurement, not a gate.** Nothing runs it automatically.
 *
 *     node test/e2e/probe-media-internals.mjs           # needs `npm run build` first
 *     ROUNDS=8 node test/e2e/probe-media-internals.mjs
 *
 * ## Why this exists
 *
 * `probe-hwdecode.mjs` established a rate (0-6 failures per 36 loads, one run
 * in seven reproducing nothing) and killed five theories by comparison, but
 * comparison is still inference: every theory was rejected by what changed
 * around the failure, never by looking at the failure itself. This probe
 * reads Chromium's own record for the exact player that failed -- which
 * decoder it used and what its properties/log/error say -- direct observation
 * instead of a sixth black-box comparison.
 *
 * ## Media domain, not the media-internals frontend page
 *
 * `chrome://media-internals` and the CDP `Media` domain
 * (`Media.playerCreated` / `playerPropertiesChanged` / `playerEventsAdded` /
 * `playerMessagesLogged` / `playerErrorsRaised`) are two views onto the same
 * underlying data. This probe uses the CDP domain directly, not the frontend
 * page, after two dead ends measured while building it:
 *
 * 1. `Target.createTarget` -- the normal way to open a second CDP-attached
 *    page for the internals frontend while driving clips in the first --
 *    returns `{"error":{"code":-32000,"message":"Not supported"}}` in this
 *    Electron build. Only one page is attachable per launch here.
 * 2. Reusing that one page (drive clips, then `Page.navigate` it to
 *    `chrome://media-internals` to read the same-process history) worked for
 *    a player that was never touched again after loading -- but the
 *    established repro condition (`probe-hwdecode.mjs`) always tears a player
 *    down (`removeAttribute` + `load()`) immediately on its own outcome,
 *    success or failure, and a JS-driven teardown does not persist into that
 *    saved history the way a page-navigation teardown does. Skipping cleanup
 *    only for the failing element and navigating right after still came back
 *    with `#player-list` **empty**, twice, on two separately-reproduced
 *    failures -- so whatever the saved-history mechanism requires, "kept
 *    alive across one navigation" measurably was not it, and no more time
 *    went into finding out what would have worked.
 *
 * The `Media` domain sidesteps the question entirely: events arrive live, on
 * the socket already open for driving the page, tagged by a stable player ID,
 * with nothing torn down or navigated away.
 *
 * ## Positive control
 *
 * Same reasoning as `probe-hwdecode.mjs`: an arm that cannot decode a 3 KB
 * H.264 clip is broken, not reporting on HEVC. Checked before the loop, and
 * its `kVideoDecoderName` is recorded too -- free corroboration of which
 * decoder path ran, from the browser's own accounting rather than inferred
 * from CPU% the way the original hardware-sessions theory was.
 *
 * ## What "no failure" means here
 *
 * The failure rate measured in `probe-hwdecode.mjs` was 0/36 in one run out of
 * seven. A run of this probe that reproduces nothing is not a clean result --
 * it is the instrument not having fired this time. It refuses to print
 * anything as if it captured a failure, and exits 1 so it cannot be mistaken
 * for "no failure exists".
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DEBUG_PORT = 9_338 // distinct from 9333-9337, used by the other probes/wire.mjs
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const CLIP_DIR = process.env.DDF_CLIP_DIR ?? resolve(APP_DIR, '..', 'test-patterns', 'Test Clips 3')
const ROUNDS = Number(process.env.ROUNDS ?? '8')
const OUT_FILE = process.env.DDF_MI_OUT
  ?? resolve(APP_DIR, '..', 'docs', 'media-internals-capture.txt')

const PICKER_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv']
const skipped = []
const CLIPS = readdirSync(CLIP_DIR).sort().filter((name) => {
  if (PICKER_EXTENSIONS.includes(extname(name).toLowerCase())) return true
  if (!name.startsWith('.')) skipped.push(name)
  return false
}).map((name) => join(CLIP_DIR, name))

const CONTROL_CLIP = process.env.DDF_CONTROL_CLIP
  ?? resolve(APP_DIR, '..', 'test-patterns', '11-white-8x8_4P-10x5.mp4')

const mediaUrl = (path) => `ddf-media://file${path.split('/').map(encodeURIComponent).join('/')}`

/** Byte-identical to `loadOne` in `probe-hwdecode.mjs` — see there for why every part of this shape (the `settled` guard, cleanup before reporting any outcome, cleanup failure as its own outcome) is load-bearing. */
const loadOne = (path) => `
  (() => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.crossOrigin = 'anonymous'
    const name = (e) => ({1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'}[e?.code] ?? 'unknown')
    return new Promise((done) => {
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

/** Every `Media.*` event carries its player's id, either at `params.player.playerId` (`playerCreated` only) or `params.playerId` (everything else). */
const playerIdOf = (event) =>
  event.method === 'Media.playerCreated' ? event.params.player.playerId : event.params.playerId

/**
 * No more position bookkeeping. Three earlier versions all relied, in some
 * form, on "this array index/window corresponds to real time, and real time
 * corresponds to which attempt something belongs to" -- and each was caught
 * assuming an ordering CDP does not actually promise:
 *
 * 1. A `playerCreated` "index window" -- broke because a successful load's
 *    trailing events aren't guaranteed flushed before the *next* clip's
 *    window opens.
 * 2. "Last `kLoad` match over the whole run" -- broke because a stale
 *    earlier round's `kLoad` for the identical URL could still be the only
 *    match by the time this was checked.
 * 3. "Match scoped to a `sinceIndex` captured right before this attempt" --
 *    this is the one Codex's last review caught, and it is the deeper
 *    problem underneath (1) and (2) too: `Media.*` events reach this socket
 *    over mojo IPC, a *different* transport than whatever carries
 *    `Runtime.evaluate`'s reply, and nothing documents that the browser
 *    process serializes those two onto the DevTools socket in an order that
 *    matches when the underlying work actually happened. A stale event from
 *    two rounds ago is exactly as capable of arriving "late" -- after this
 *    attempt's `before` was captured -- as a fresh one is. An index is a
 *    position in *arrival order*, not in *logical* order, and this file kept
 *    conflating the two.
 *
 * The fix is to stop needing arrival order at all. `findFailingPlayerIdForUrl`
 * below identifies the failing player by TWO content facts that are true
 * regardless of when either arrives: it loaded `targetUrl` (a `kLoad` event
 * says so), and it is the one that actually failed (a
 * `Media.playerErrorsRaised` event says so). An earlier, successful round of
 * the identical clip has a `kLoad` for the same URL but never a
 * `playerErrorsRaised` -- so requiring both, rather than either alone, rules
 * out every successful load regardless of arrival order.
 *
 * More than one match is not an error condition here, unlike the identically-
 * shaped case in `findPlayerIdForUrl` below. Measured: the app authorizes
 * this exact URL as one of its own cues too (it has to, to reach
 * `allowedMedia`), so its own one-shot thumbnail/duration fan-out
 * (`PlayScreen.tsx`, no retry logic) sometimes hits this same bug on this
 * same clip *before* this probe's own loop even starts. That is a second,
 * independent instance of the identical defect on the identical file --
 * there is no "wrong" one to pick between two manifestations of the same
 * bug, so any match is reported rather than refusing to choose.
 */
function findFailingPlayerIdForUrl(events, targetUrl) {
  const loadedThisUrl = new Set()
  const raisedAnError = new Set()
  for (const e of events) {
    if (e.method === 'Media.playerEventsAdded') {
      for (const ev of e.params.events) {
        let parsed
        try { parsed = JSON.parse(ev.value) } catch { continue }
        if (parsed.event === 'kLoad' && parsed.url === targetUrl) loadedThisUrl.add(e.params.playerId)
      }
    } else if (e.method === 'Media.playerErrorsRaised') {
      raisedAnError.add(e.params.playerId)
    }
  }
  const matches = [...loadedThisUrl].filter((id) => raisedAnError.has(id))
  if (matches.length === 0) return { ok: false }
  return { ok: true, playerId: matches[0], count: matches.length }
}

/**
 * For the control clip's decoder-name lookup only. It is authorized as one of
 * the app's own cues (it has to be, to reach `allowedMedia` at all), so the
 * app's own thumbnail/duration fan-out loads that exact URL too, independently
 * of this probe's own `loadOne` call -- measured: the "exactly one match"
 * version of this refused every time, because there are legitimately two
 * successful loads of it. Unlike the failing clip, there is no error to
 * disambiguate by (a successful decode never raises one), but there does not
 * need to be one: every successful load of the identical local file goes
 * through the identical handler and decoder-selection logic, so whichever
 * match this returns reports the same `kVideoDecoderName` either way. Any
 * match is as good as any other here -- unlike `findFailingPlayerIdForUrl`,
 * where picking the wrong one of several matches would misattribute a real
 * failure, picking either successful control player reports the same thing.
 */
function findPlayerIdForUrl(events, targetUrl) {
  for (const e of events) {
    if (e.method !== 'Media.playerEventsAdded') continue
    for (const ev of e.params.events) {
      let parsed
      try { parsed = JSON.parse(ev.value) } catch { continue }
      if (parsed.event === 'kLoad' && parsed.url === targetUrl) return e.params.playerId
    }
  }
  return null
}

/** Polls rather than trusting a fixed sleep -- the mojo IPC delay for MediaLog entries has no documented upper bound, so waiting is bounded by attempts, not a guessed duration. Refuses (does not guess) if the required content never shows up at all. */
async function waitFor(check, context, timeoutMessage) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const found = check()
    if (found !== null) return found
    await sleep(200)
  }
  throw new Error(`${context}: ${timeoutMessage} — cannot reliably identify which load these events belong to`)
}

function openPage(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    /** Every `Media.*` event, in arrival order, across the whole run -- "arrival order" being the operative caveat. Identified per-load purely by content (which URL loaded, whether that player raised an error), never by array position or a mutable label -- see `findFailingPlayerIdForUrl`'s comment for why three earlier designs, all based on some notion of "before"/"after" in this array, each turned out to assume an ordering CDP does not promise. */
    const mediaEvents = []
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
      if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        if (waiter === undefined) return
        pending.delete(message.id)
        waiter(message)
      } else if (message.method !== undefined && message.method.startsWith('Media.')) {
        mediaEvents.push(message)
      }
    })
    socket.addEventListener('error', fail)
    socket.addEventListener('open', async () => {
      await send('Page.enable', {})
      await send('Runtime.enable', {})
      done({
        mediaEvents,
        async evaluate(expression) {
          const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
          if (reply.result?.exceptionDetails !== undefined) {
            throw new Error(`page threw: ${reply.result.exceptionDetails.text}`)
          }
          return reply.result?.result?.value
        },
        async enableMedia() {
          const reply = await send('Media.enable', {})
          if (reply.result === undefined) throw new Error(`Media.enable failed: ${JSON.stringify(reply)}`)
        },
        close: () => socket.close(),
      })
    })
  })
}

const problems = []
let electron = null
try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js missing — run `npm run build` first')
  if (CLIPS.length === 0) throw new Error(`no clips in ${CLIP_DIR} — nothing to measure`)
  if (skipped.length > 0) console.log(`note: not measured: ${skipped.join(', ')}`)

  try {
    const stale = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    if (stale.ok) throw new Error(`something is already listening on ${DEBUG_PORT} — kill it: lsof -ti :${DEBUG_PORT} | xargs kill -9`)
  } catch (error) {
    if (String(error).includes('already listening')) throw error
  }

  electron = spawn(
    resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
    [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DDF_ADDRESS: '127.0.0.1',
        DDF_PORT: '60004',
        DDF_PICK_MEDIA: [...CLIPS, CONTROL_CLIP].join(':'),
      },
      stdio: 'ignore',
      detached: true,
    },
  )

  let page = null
  for (let attempt = 0; attempt < 100 && page === null; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target !== undefined) page = await openPage(target.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    if (page === null) await sleep(200)
  }
  if (page === null) throw new Error('Electron never exposed a debuggable page')
  await page.enableMedia()

  // Authorize every clip + the control via the real UI flow. Same sequence as
  // `probe-hwdecode.mjs`'s `runArm` -- see there for why each step is needed.
  let ready = false
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    ready = await page.evaluate('[...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Open Player"))')
    if (!ready) await sleep(200)
  }
  if (!ready) throw new Error('the Mapping surface never mounted')
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
  if (!hasButton) throw new Error('the Play surface never mounted')
  await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
  await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('.add-menu [role="menuitem"]')].find((b) => b.textContent.includes('Upload media'))
    if (item === undefined) throw new Error('no Upload media item in the + menu')
    item.click()
  })()`)
  const expectedCues = CLIPS.length + 1
  let cueCount = 0
  for (let attempt = 0; attempt < 60 && cueCount < expectedCues; attempt++) {
    cueCount = await page.evaluate('document.querySelectorAll(".cue-row").length')
    if (cueCount < expectedCues) await sleep(200)
  }
  if (cueCount < expectedCues) throw new Error(`only ${cueCount}/${expectedCues} clips were authorized`)
  await sleep(8000) // let the app's own thumbnail/duration fan-outs finish first

  const control = await page.evaluate(loadOne(CONTROL_CLIP))
  if (control !== 'DECODES') {
    throw new Error(`positive control ${CONTROL_CLIP.split('/').pop()} did not decode (${control}) — this arm is broken`)
  }
  const controlId = await waitFor(
    () => findPlayerIdForUrl(page.mediaEvents, mediaUrl(CONTROL_CLIP)),
    'positive control',
    `no unambiguous kLoad for ${CONTROL_CLIP.split('/').pop()} appeared within 5s`,
  )

  console.log(`${CLIPS.length} clips, up to ${ROUNDS} rounds, waiting for one failure to capture...`)
  let failure = null
  outer:
  for (let round = 0; round < ROUNDS && failure === null; round++) {
    for (const clip of CLIPS) {
      const outcome = await page.evaluate(loadOne(clip))
      if (outcome.startsWith('CLEANUP FAILED')) {
        throw new Error(`decoder teardown failed on ${clip.split('/').pop()} (${outcome}) — ` +
          'isolation is no longer guaranteed; this run cannot be trusted')
      }
      if (outcome !== 'DECODES') {
        console.log(`captured: ${clip.split('/').pop()} (round ${round + 1}) -> ${outcome}`)
        const url = mediaUrl(clip)
        let matchCount = 0
        const playerId = await waitFor(
          () => {
            const result = findFailingPlayerIdForUrl(page.mediaEvents, url)
            if (!result.ok) return null
            matchCount = result.count
            return result.playerId
          },
          `failing load (${clip.split('/').pop()})`,
          'no player both loaded this URL and raised an error within 5s',
        )
        failure = { clip, round, outcome, playerId, matchCount }
        break outer
      }
    }
  }

  if (failure === null) {
    throw new Error(
      `no failure in ${ROUNDS * CLIPS.length} loads — this run reproduced nothing (measured base rate is ` +
      `0-6 per 36, and 1 run in 7 reproduces nothing at all). Re-run, do not report "no failure exists".`,
    )
  }

  // Identified by playerId, not by any time-window label -- see the comment
  // on `mediaEvents` in `openPage` for why a label was not good enough here.
  const failureEvents = page.mediaEvents.filter((e) => playerIdOf(e) === failure.playerId)
  const controlEvents = page.mediaEvents.filter((e) => playerIdOf(e) === controlId)
  const decoderName = (events) => events
    .filter((e) => e.method === 'Media.playerPropertiesChanged')
    .flatMap((e) => e.params.properties)
    .find((p) => p.name === 'kVideoDecoderName')?.value ?? '(none reported)'

  const formatEvents = (events) => events.map((e) => {
    if (e.method === 'Media.playerCreated') return `[created] playerId=${e.params.player.playerId}`
    if (e.method === 'Media.playerPropertiesChanged') {
      return e.params.properties.map((p) => `[property] ${p.name} = ${p.value}`).join('\n')
    }
    if (e.method === 'Media.playerEventsAdded') {
      return e.params.events.map((ev) => `[event ${ev.timestamp.toFixed(3)}] ${ev.value}`).join('\n')
    }
    if (e.method === 'Media.playerMessagesLogged') {
      return e.params.messages.map((m) => `[log ${m.level}] ${m.message}`).join('\n')
    }
    if (e.method === 'Media.playerErrorsRaised') {
      return e.params.errors.map((err) => `[ERROR] ${JSON.stringify(err)}`).join('\n')
    }
    return `[${e.method}] ${JSON.stringify(e.params)}`
  }).join('\n')

  const report = [
    `# media pipeline capture (CDP Media domain)`,
    ``,
    `Generated by \`app/test/e2e/probe-media-internals.mjs\`. Not hand-written -- re-run to reproduce.`,
    ``,
    `## Positive control: ${CONTROL_CLIP.split('/').pop()}`,
    ``,
    `Decoded successfully. Decoder: ${decoderName(controlEvents)}`,
    ``,
    `## Failing clip: ${failure.clip.split('/').pop()}`,
    ``,
    `Round: ${failure.round + 1} of ${ROUNDS}`,
    `Outcome: ${failure.outcome}`,
    `Decoder: ${decoderName(failureEvents)}`,
    `Player id: ${failure.playerId}`,
    ...(failure.matchCount > 1
      ? [`NOTE: ${failure.matchCount} independent players both loaded this URL and raised an error -- likely`,
        `the app's own thumbnail/duration fan-out hit the same bug on the same clip independently of this`,
        `probe's own attempt. The trace below is one of them, not provably *this* round's specific attempt --`,
        `both are genuine instances of the identical failure on the identical file, so this does not weaken`,
        `the finding, but the "Round" label above should not be read as naming which of the two produced it.`]
      : []),
    ``,
    `### Full event stream for this load, in arrival order`,
    ``,
    formatEvents(failureEvents),
    ``,
  ].join('\n')

  writeFileSync(OUT_FILE, report)
  console.log(`\nwritten to ${OUT_FILE}`)
  console.log(report)
} catch (error) {
  console.error(`\nrun failed: ${error}`)
  problems.push(String(error))
} finally {
  if (electron !== null) {
    try { process.kill(-electron.pid, 'SIGKILL') } catch { electron.kill('SIGKILL') }
  }
  if (problems.length > 0) {
    console.error(`\nPROBE UNUSABLE — ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
  }
}
