/**
 * Does one real clip open through the running app's `ddf-media://` handler?
 *
 *     node test/e2e/probe-moov-clip.mjs /path/to/clip.mov
 *
 * **An instrument, not a gate.** Nothing runs it automatically, and it takes a
 * path on the command line precisely so that the clip it grades can be one of
 * the operator's own files, sitting outside this repo, without a
 * machine-specific path being committed anywhere.
 *
 * ## What it was written for
 *
 * `ddf-media://` could not answer a `Range` request with a `206` until
 * 2026-09-18, so an MP4 or MOV whose `moov` atom sits after `mdat` — which must
 * be read from the tail before anything decodes — never opened. The correlation
 * came out of one night's job log: 124/124 `moov`-at-front clips played, 0/7
 * `moov`-at-end clips did.
 *
 * That is a correlation found in the data that produced the theory. This exists
 * to test it **out of sample**, against a clip the log has no verdict for at
 * all, where the mechanism makes a falsifiable prediction before the run: a
 * `moov`-at-end clip must fail on a build without the fix and play on one with
 * it. MEASURED 2026-09-18 against `Dashed Spheres.mov` (1920×1080 H.264, 5.5 MB,
 * `ftyp,wide,mdat,moov`, zero appearances in the job log):
 *
 *     pre-fix build   control PLAYED · target FAILED
 *                     PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN
 *     fixed build     control PLAYED · target PLAYED
 *
 * ## The positive control
 *
 * The clip is remuxed with `-c copy -movflags +faststart`, which moves the
 * `moov` atom to the front and changes nothing else — same encoded frames, same
 * codec, same resolution. That remux must play. If it does not, the failure is
 * the codec, the compositor or the authorisation rather than the atom order,
 * the target result is not a measurement of anything, and this prints no
 * verdict for it and exits non-zero. A single clip that failed on its own would
 * be indistinguishable from an instrument that was broken.
 *
 * Both files are authorised through the app's own `ddf:pick-media` path via the
 * `DDF_PICK_MEDIA` seam, because a 403 body reaches the demuxer as
 * `DEMUXER_ERROR_COULD_NOT_OPEN` — the identical string an unopenable container
 * produces. `docs/POSTMORTEMS.md`, "Container blacklist from belief": that
 * substitution is how a uniformly false table once looked entirely plausible.
 *
 * Requires `npm run build` first, and `ffmpeg` and `python3` on `PATH`.
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const APP_DIR = resolve(import.meta.dirname, '..', '..')
const REPO_ROOT = resolve(APP_DIR, '..')
const PYTHON = process.env.DDF_PYTHON ?? 'python3'
// Its own debug port and UDP port, so this can run beside nothing and still not
// collide with `wire.mjs`'s hardcoded 9333 / 60001 if someone runs both.
const DEBUG_PORT = 9_355
const SEND_PORT = 60_009

const target = process.argv[2]
if (target === undefined || !existsSync(target)) {
  console.error(`usage: node ${basename(import.meta.filename)} FILE`)
  console.error('  FILE is any clip on this machine — it is never written down here.')
  process.exit(2)
}
if (!existsSync(join(APP_DIR, 'dist', 'main.js'))) {
  console.error('dist/main.js is missing — run `npm run build` first')
  process.exit(2)
}

const workspace = mkdtempSync(join(tmpdir(), 'ddf-moov-probe-'))
const control = join(workspace, `control-front${extname(target)}`)
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', target, '-c', 'copy', '-movflags', '+faststart', control,
])

/** Where `moov` sits, per the independent walker in `tools/moov_position.py`. */
function moovPosition(path) {
  const printed = execFileSync(
    PYTHON, [join(REPO_ROOT, 'tools', 'moov_position.py'), path], { encoding: 'utf8' })
  const line = printed.split('\n').find((text) => text.endsWith(basename(path)))
  return line === undefined ? 'UNREADABLE' : line.split('\t')[0]
}

const targetOrder = moovPosition(target)
const controlOrder = moovPosition(control)
console.log(`target   ${targetOrder}\t${target}`)
console.log(`control  ${controlOrder}\t${basename(control)} (-c copy +faststart remux)`)
if (controlOrder !== 'FRONT') {
  console.error(`the +faststart remux reads ${controlOrder}, not FRONT — there is no control here.`)
  rmSync(workspace, { recursive: true, force: true })
  process.exit(3)
}

function open(url) {
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
            expression, returnByValue: true, awaitPromise: true,
          })
          // A page that threw must not read as one that answered — the first of
          // the five mistakes `probe-containers.mjs` made and this file inherits
          // the fix for.
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

async function attachToPage() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const found = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (found !== undefined) return await open(found.webSocketDebuggerUrl)
    } catch {
      // Not up yet.
    }
    await sleep(200)
  }
  throw new Error('Electron never exposed a debuggable page')
}

const mediaUrl = (path) => `ddf-media://file${path.split('/').map(encodeURIComponent).join('/')}`

const child = spawn(
  resolve(APP_DIR, 'node_modules', '.bin', 'electron'),
  [
    resolve(APP_DIR, 'dist', 'main.js'),
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(workspace, 'profile')}`,
  ],
  {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DDF_ADDRESS: '127.0.0.1',
      DDF_PORT: String(SEND_PORT),
      DDF_PICK_MEDIA: [target, control].join(':'),
    },
    stdio: 'ignore',
    // `node_modules/.bin/electron` is a Node shim that spawns the real binary as
    // its own child, so killing the shim orphans Electron and it keeps the debug
    // port — hijacking the *next* run. Its own process group is what makes the
    // teardown able to take both.
    detached: true,
  },
)

let page = null
let failed = false
try {
  page = await attachToPage()
  const authorised = await page.evaluate('window.ddf.pickMedia()')
  if (!Array.isArray(authorised) || authorised.length !== 2) {
    throw new Error(`DDF_PICK_MEDIA authorised ${JSON.stringify(authorised)}, wanted both files`)
  }

  const load = (path) => page.evaluate(`
    new Promise((done) => {
      const v = document.createElement('video')
      v.muted = true
      v.crossOrigin = 'anonymous'
      v.addEventListener('loadeddata', () => done('PLAYED'))
      v.addEventListener('error', () => done('FAILED: ' + (v.error ? v.error.message : 'no error object')))
      // A distinct outcome, not a third vote for FAILED: a handler that never
      // answered and a handler that refused are different findings.
      setTimeout(() => done('TIMEOUT'), 20000)
      v.src = ${JSON.stringify(mediaUrl(path))}
      v.load()
    })`)

  const controlVerdict = await load(control)
  console.log(`\nCONTROL (moov FRONT)  ${controlVerdict}`)
  if (controlVerdict !== 'PLAYED') {
    console.error('\nPOSITIVE CONTROL FAILED — this build cannot play the clip even with `moov`')
    console.error('at the front, so nothing about the target would be a measurement of atom')
    console.error('order. Refusing to report it.')
    failed = true
  } else {
    console.log(`TARGET  (moov ${targetOrder})${targetOrder === 'FRONT' ? '  ' : '    '}${await load(target)}`)
  }
} catch (error) {
  console.error(`probe failed: ${String(error)}`)
  failed = true
} finally {
  page?.close()
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
  await sleep(300)
  rmSync(workspace, { recursive: true, force: true })
}

// Non-zero on failure, so `probe && next-thing` cannot sail past a broken run.
process.exit(failed ? 1 : 0)
