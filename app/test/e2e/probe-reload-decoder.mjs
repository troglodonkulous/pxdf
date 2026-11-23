/**
 * When decode recovery reloads a clip, which decoder does the new player get,
 * and does the old one go away?
 *
 * **A measurement, not a gate.** Nothing runs it automatically.
 *
 *     npm run build && node test/e2e/probe-reload-decoder.mjs
 *
 * ## Why this exists
 *
 * `docs/media-internals-capture.txt` records September's failure class from
 * Chromium's own side: an HEVC clip on `VideoToolboxVideoDecoder` (hardware)
 * raising `PIPELINE_ERROR_DECODE`, intermittently, on files a software decoder
 * handles perfectly. Decode recovery answers it by reloading the clip into a
 * new element. That only helps if two things hold, and neither is visible
 * from the app:
 *
 *  1. **The reload is a new player, and the failed one is destroyed.** A
 *     reload that kept the failed player, or leaked it, would hold a hardware
 *     decoder session per recovery for the life of the show.
 *  2. **Which decoder the reload selects.** If it is VideoToolbox again, the
 *     recovery is betting the failure is transient — which September's data
 *     supports (116 errors across 38 clips, none of them every time) but does
 *     not prove. If a software decoder existed for HEVC, a reload could fall
 *     back to it; the `--disable-accelerated-video-decode` arms ask whether
 *     one does.
 *
 * ## The instrument
 *
 * One launch per arm: {H.264, HEVC} x {default, `--disable-accelerated-video-decode`}.
 * Each authors its own 768 x 768 fixture, puts it live through Standby and GO,
 * and injects one decode error on it through `PXDF_FAULT_DECODE` after 3 s.
 * The CDP `Media` domain is enabled before the cue is added, so every player
 * that ever loads the clip — the thumbnail, the duration probe, the live
 * source and any reload — is recorded.
 *
 * **Players are identified by content, never by arrival order** (see
 * `probe-media-internals.mjs` for why order is not trustworthy here): a player
 * belongs to the clip if a `kLoad` names its URL, its decoder is its
 * `kVideoDecoderName` property, and it is gone if it logged
 * `kWebMediaPlayerDestroyed`. An injected error never reaches Chromium's
 * pipeline, so no player raises one; the faulted player is identified only as
 * "a player of this clip that was destroyed", and the reload as "the one still
 * alive at the end".
 *
 * ## Positive controls — a failure refuses the arm
 *
 *  - The seam injected exactly once (the renderer's log line).
 *  - At least one player of the clip reported a decoder name.
 *  - The switch arms differ from their default arm in at least one decoder
 *    name, or the cue failed to play at all. A switch that changed nothing
 *    is a switch Electron did not pass to Chromium, and its arm says nothing.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const DEBUG_PORT = 9_342
const SIDECAR_PORT = 60_007
const APP_DIR = resolve(import.meta.dirname, '..', '..')
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'Electron', 'pxdf.log')
const AFTER_MS = 3_000
const SWITCH = '--disable-accelerated-video-decode'

const ARMS = [
  { codec: 'h264', accel: true },
  { codec: 'h264', accel: false },
  { codec: 'hevc', accel: true },
  { codec: 'hevc', accel: false },
]

function makeClip(directory, codec) {
  const path = join(directory, `reload-${codec}.mp4`)
  const encoder = codec === 'hevc'
    ? ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error']
    : ['-c:v', 'libx264']
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=768x768:r=30:d=10',
    ...encoder, '-pix_fmt', 'yuv420p', '-g', '30', '-movflags', '+faststart', path,
  ])
  return path
}

const mediaUrl = (path) => `pxdf-media://file${path.split('/').map(encodeURIComponent).join('/')}`

async function attachToPage() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const page = (await response.json()).find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return await openPage(page.webSocketDebuggerUrl)
    } catch {
      // The port is not up yet.
    }
    await sleep(200)
  }
  throw new Error('Electron never exposed a debuggable page')
}

function openPage(url) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    const mediaEvents = []
    const exceptions = []
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
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).split('\n')[0])
      } else if (message.method?.startsWith('Media.')) {
        mediaEvents.push(message)
      }
    })
    socket.addEventListener('error', fail)
    socket.addEventListener('open', async () => {
      await send('Runtime.enable', {})
      const media = await send('Media.enable', {})
      if (media.result === undefined) {
        fail(new Error(`Media.enable failed: ${JSON.stringify(media)}`))
        return
      }
      done({
        mediaEvents,
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

/** Every player that loaded `url`, with its decoder and whether it was destroyed. */
function playersFor(events, url) {
  const players = new Map()
  const get = (id) => {
    if (!players.has(id)) players.set(id, { id, loaded: false, decoder: null, destroyed: false, playing: false, errors: [] })
    return players.get(id)
  }
  for (const e of events) {
    const id = e.method === 'Media.playerCreated' ? e.params.player?.playerId : e.params.playerId
    if (id === undefined) continue
    if (e.method === 'Media.playerEventsAdded') {
      for (const ev of e.params.events) {
        let parsed
        try { parsed = JSON.parse(ev.value) } catch { continue }
        if (parsed.event === 'kLoad' && parsed.url === url) get(id).loaded = true
        if (parsed.event === 'kWebMediaPlayerDestroyed') get(id).destroyed = true
        if (parsed.event === 'kPipelineStateChange' && parsed.pipeline_state === 'kPlaying') get(id).playing = true
      }
    } else if (e.method === 'Media.playerPropertiesChanged') {
      const name = e.params.properties.find((p) => p.name === 'kVideoDecoderName')
      if (name !== undefined) get(id).decoder = name.value
    } else if (e.method === 'Media.playerErrorsRaised') {
      get(id).errors.push(...e.params.errors.map((err) => `${err.errorType}:${err.code}`))
    }
  }
  return [...players.values()].filter((p) => p.loaded)
}

const clickButtonScript = (text) => `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))
  if (button === undefined) throw new Error('no button labelled ${text}')
  button.click()
  return true
})()`

async function runArm(workspace, arm) {
  const clip = makeClip(workspace, arm.codec)
  const spec = { match: `reload-${arm.codec}`, afterMs: AFTER_MS, mode: 'once' }
  const sink = createSocket('udp4')
  await new Promise((done) => sink.bind(SIDECAR_PORT, '127.0.0.1', done))
  let electron = null
  let page = null
  const result = { arm: `${arm.codec} ${arm.accel ? 'default' : SWITCH}`, refused: [], notes: [] }
  try {
    const args = [resolve(APP_DIR, 'dist', 'main.js'), `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${join(workspace, `profile-${arm.codec}-${arm.accel}`)}`]
    if (!arm.accel) args.push(SWITCH)
    electron = spawn(resolve(APP_DIR, 'node_modules', '.bin', 'electron'), args, {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PXDF_ADDRESS: '127.0.0.1',
        PXDF_PORT: String(SIDECAR_PORT),
        PXDF_PICK_MEDIA: clip,
        PXDF_CUE_SEED: JSON.stringify({ [clip]: { loop: null, trimStartMs: 0, trimEndMs: null } }),
        PXDF_FAULT_DECODE: JSON.stringify(spec),
      },
      stdio: 'ignore',
      detached: true,
    })
    page = await attachToPage()
    const waitFor = async (expression, attempts = 50) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await page.evaluate(expression)
        if (value) return value
        await sleep(200)
      }
      return null
    }
    if (await waitFor('document.querySelector(".mapping-screen") !== null') === null) throw new Error('Mapping never mounted')
    await page.evaluate(clickButtonScript('Open Player'))
    await waitFor('document.querySelector(\'[aria-label="Add cue"]\') !== null')
    await page.evaluate('document.querySelector(\'[aria-label="Add cue"]\').click()')
    await page.evaluate(`[...document.querySelectorAll('.add-menu [role="menuitem"]')].find((b) => b.textContent.includes('Upload')).click()`)
    if (await waitFor('document.querySelectorAll(".cue-row").length === 1') === null) throw new Error('the clip never reached the cue stack')
    await sleep(2_000)
    await page.evaluate('document.querySelectorAll(".cue-row")[0].click()')
    await waitFor('(() => { const b = document.querySelector(".go-button"); return b !== null && !b.disabled })()')
    await page.evaluate('document.querySelector(".go-button").click()')
    const live = await waitFor('document.querySelector(".cue-row.is-live") !== null ? 1 : 0', 30)
    result.wentLive = live === 1

    const injected = () => (existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '')
      .split('\n').filter((line) => line.includes('injected decode error into ') && line.includes(clip)).length
    const deadline = Date.now() + AFTER_MS + 10_000
    while (injected() === 0 && Date.now() < deadline) await sleep(200)
    await sleep(6_000)

    const log = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : ''
    const lines = log.split('\n')
    result.injected = injected()
    result.recovered = lines.filter((l) => l.includes('recovered on') && l.includes(clip)).length
    result.started = lines.filter((l) => l.includes('starting recovery') && l.includes(clip)).length
    result.banner = String(await page.evaluate('document.querySelector(".error-banner")?.textContent ?? ""'))
    result.stillLive = await page.evaluate('document.querySelector(".cue-row.is-live") !== null')
    result.players = playersFor(page.mediaEvents, mediaUrl(clip))
    result.exceptions = [...page.exceptions]

    if (result.wentLive && result.injected !== 1) result.refused.push(`the seam injected ${result.injected} times, want 1`)
    // A cue that never played with every player of it raising an error is a
    // finding — no decoder exists for it on this arm — not a broken probe.
    // Silence is: no decoder named, and no error to say why.
    const explained = !result.wentLive && result.players.length > 0 && result.players.every((p) => p.errors.length > 0)
    if (result.players.every((p) => p.decoder === null) && !explained) result.refused.push('no player of the clip reported a decoder, and none raised an error')
    if (explained) result.notes.push(`no decoder for this clip on this arm: every player raised ${[...new Set(result.players.flatMap((p) => p.errors))].join(', ')}`)
    else if (!result.wentLive) result.notes.push('the cue never went live, so no fault could be injected')
  } catch (error) {
    result.refused.push(`did not complete: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    page?.close()
    if (electron !== null) {
      try { process.kill(-electron.pid, 'SIGKILL') } catch { /* already gone */ }
      await sleep(500)
    }
    sink.close()
  }
  return result
}

const workspace = mkdtempSync(join(tmpdir(), 'pxdf-reload-'))
const results = []
let exitCode = 0
try {
  if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) throw new Error('dist/main.js is missing — run `npm run build` first')
  for (const arm of ARMS) results.push({ ...arm, ...(await runArm(workspace, arm)) })

  // The switch control: an arm with the switch must differ from its default
  // arm somewhere, or the switch never reached Chromium.
  for (const codec of ['h264', 'hevc']) {
    const on = results.find((r) => r.codec === codec && r.accel)
    const off = results.find((r) => r.codec === codec && !r.accel)
    const names = (r) => [...new Set(r.players.map((p) => p.decoder).filter((d) => d !== null))].sort().join(',')
    if (off.players !== undefined && on.players !== undefined && names(on) === names(off) && off.wentLive === on.wentLive) {
      off.refused.push(`${SWITCH} changed nothing for ${codec} (decoders ${names(off) || 'none'} either way) — the switch did not reach Chromium`)
    }
  }

  for (const r of results) {
    console.log(`\n== ${r.arm}`)
    if (r.refused.length > 0) {
      console.log(`  REFUSED: ${r.refused.join(' · ')}`)
      exitCode = 2
    }
    for (const note of r.notes) console.log(`  note: ${note}`)
    if (r.players === undefined) continue
    console.log(`  went live ${r.wentLive} · injected ${r.injected} · recovery started ${r.started} · recovered ${r.recovered} · still live ${r.stillLive}`)
    if (r.banner !== '') console.log(`  banner: ${r.banner}`)
    const alive = r.players.filter((p) => !p.destroyed)
    console.log(`  players of the clip: ${r.players.length} (${alive.length} alive at the end)`)
    for (const p of r.players) {
      console.log(`    ${p.id.slice(0, 8)}  decoder ${p.decoder ?? '(none)'}  ${p.playing ? 'played' : 'never played'}  ` +
        `${p.destroyed ? 'destroyed' : 'ALIVE'}${p.errors.length > 0 ? `  errors ${p.errors.join(',')}` : ''}`)
    }
    if (r.exceptions.length > 0) console.log(`  page exceptions: ${r.exceptions.join(' · ')}`)
  }
} catch (error) {
  console.log(`\nthe probe did not complete: ${error instanceof Error ? error.stack : String(error)}`)
  exitCode = 1
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
process.exit(exitCode)
