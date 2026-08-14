import { fileURLToPath, pathToFileURL } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, net, powerSaveBlocker, protocol } from 'electron'
import { floorGeometry, SHOP_RIG } from '../src/render/geometry.js'
import { blackFrame } from '../src/render/onePass.js'
import { PICKER_EXTENSIONS } from '../src/player/mediaFormats.js'
import { MEDIA_SCHEME, mediaPath, mediaUrl } from '../src/player/mediaUrl.js'
import type { ShowFloor } from '../src/player/show.js'
import { runMapperPlan } from './mapperPlan.js'
import { Sidecar, type SenderStatus } from './sidecar.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDirectory, '../..')

// Must run before the app is ready, which is why it is at module scope rather
// than inside `whenReady`. `standard` gives media URLs a real origin, `secure`
// keeps them out of the mixed-content rules that would block them on the dev
// server, and `stream` marks the scheme as one whose responses are streamed
// rather than buffered whole.
//
// `corsEnabled` is the load-bearing one, and leaving it off cost this project a
// whole session. A media URL on this scheme is cross-origin to the page however
// the page was served — `file://` when packaged, `http://127.0.0.1:<port>` under
// the dev server — so drawing the video into a canvas taints it, and the render
// loop's `getImageData` throws `SecurityError` on every frame from the moment
// the first cue goes live. Nothing reaches the wire and nothing says why.
//
// Untainting it needs the media fetched in CORS mode, which needs two things
// that only work together: `video.crossOrigin = 'anonymous'` in `videoSource.ts`,
// and this flag. Without the flag Chromium refuses the request outright —
// "Cross origin requests are only supported for protocol schemes: chrome,
// chrome-extension, chrome-untrusted, data, http, https" — and the element
// fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` before it decodes anything. Measured
// on Electron 43 across the four combinations of this flag and the header
// below; only the pair reads back clean pixels.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

let mainWindow: BrowserWindow | null = null
let sidecar: Sidecar | null = null
let currentStatus: SenderStatus = 'restarting'
let currentFloor: ShowFloor = { type: SHOP_RIG.type, tileCols: SHOP_RIG.tileCols, tileRows: SHOP_RIG.tileRows }
let currentBlackFrame: Uint8Array = blackFrame(SHOP_RIG)
let quitAfterStop = false
let stopInProgress = false

function publishStatus(status: SenderStatus): void {
  currentStatus = status
  mainWindow?.webContents.send('ddf:status', status)
}

// One queue for every operation that touches sidecar's lifecycle: floor
// changes, NIC changes, and quit. Two independent callers racing to stop and
// replace the same instance is exactly the hazard sidecar.ts documents for
// crash respawn — unifying them here is what stops before-quit and a
// mid-flight setFloor from touching sidecar out of order.
let sidecarQueue: Promise<void> = Promise.resolve()

function withSidecar<T>(fn: () => Promise<T>): Promise<T> {
  const result = sidecarQueue.then(fn)
  // Swallow so one failed operation does not wedge the queue for the next one.
  // The caller still sees its own rejection through result.
  sidecarQueue = result.then(() => undefined, () => undefined)
  return result
}

async function doSetFloor(next: ShowFloor): Promise<void> {
  // Validate BEFORE touching anything live. floorGeometry throws on an
  // unknown type or an illegal tile count, and that must reject setFloor's
  // promise WITHOUT having stopped the running sidecar — otherwise a bad
  // selection leaves the floor with no sender at all.
  const geometry = floorGeometry(next.type, next.tileCols, next.tileRows)

  await sidecar?.stop()          // last frame on the wire is black, at the OLD size
  const black = blackFrame(geometry)
  sidecar = new Sidecar({
    isPackaged: app.isPackaged,
    repoRoot,
    type: next.type,
    cols: next.tileCols,
    rows: next.tileRows,
    blackFrame: black,
    onStatus: publishStatus,
  })
  sidecar.start()
  currentFloor = next
  currentBlackFrame = black
}

function setFloor(next: ShowFloor): Promise<void> {
  return withSidecar(() => doSetFloor(next))
}

function setLocalIp(address: string | undefined): Promise<void> {
  if (address !== undefined && address.length > 0) process.env.DDF_LOCAL_IP = address
  else delete process.env.DDF_LOCAL_IP
  // Re-spawns at the current geometry so the new env var takes effect.
  // Sidecar's spawn reads process.env.DDF_LOCAL_IP fresh on every call;
  // there is simply no path that rebinds a live child.
  return withSidecar(() => doSetFloor(currentFloor))
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: 'DDF Sender',
    backgroundColor: '#07090a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(currentDirectory, 'preload.cjs'),
    },
  })

  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null

    // On macOS the app stays alive with no windows, so closing the last one
    // destroys the renderer while the sidecar keeps running — and the sidecar
    // re-sends its last frame forever, which is the correct behaviour for a
    // stalled renderer and the wrong one for a renderer that no longer exists.
    // The floor would hold whatever was on it with no UI left to change it.
    // Black is the only safe frame to leave behind; the socket stays open,
    // because stopping the send is what makes controller 1 revert to the
    // vendor's own content when it is in Master/IR mode (in slave mode it
    // would hold its last frame instead, same as 2 and 3 — either way, black
    // is the only frame safe to leave on the floor with nobody driving it).
    if (BrowserWindow.getAllWindows().length === 0) sidecar?.writeFrame(currentBlackFrame)
  })
  window.webContents.on('did-finish-load', () => publishStatus(currentStatus))

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(currentDirectory, 'index.html'))
  }
}

ipcMain.on('ddf:frame', (_event: unknown, frame: Uint8Array) => {
  sidecar?.writeFrame(frame)
})

ipcMain.handle('ddf:mapper-plan', (_event, type: string, cols: number, rows: number) => {
  return runMapperPlan(type, cols, rows)
})

ipcMain.handle('ddf:list-interfaces', () => {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(({ family, internal }) => family === 'IPv4' && !internal)
      .map(({ address }) => ({ name, address })),
  )
})

ipcMain.handle('ddf:set-floor', (_event, floor: ShowFloor) => setFloor(floor))
ipcMain.handle('ddf:set-local-ip', (_event, address: string | undefined) => setLocalIp(address))

/**
 * Every path the operator has chosen this session, and the only paths the media
 * handler will serve.
 *
 * The handler below is callable by anything executing in the renderer, with a
 * path of its choosing. Validating that the URL is *well formed* is not the same
 * as validating that the request is one we meant to serve — without this set,
 * registering the scheme handed the page a read-any-file capability, which the
 * renderer is the untrusted side of by design.
 *
 * The list can only be added to by a human choosing a file in a native dialog,
 * so the operator's choice *is* the authorisation. A fully compromised renderer
 * can then re-read files that were already opened deliberately, and nothing
 * else. PR 5's "open show file" will add its cue paths here for the same reason:
 * somebody chose that show.
 */
const allowedMedia = new Set<string>()

ipcMain.handle('ddf:pick-media', async (): Promise<string[]> => {
  const chosen = await chooseMedia()
  for (const path of chosen) allowedMedia.add(servedForm(path))
  return chosen
})

/**
 * A chosen path in exactly the form the handler will see it come back.
 *
 * The membership test has to be an equality check on the same value, not a
 * second opinion about what two paths mean — but `mediaUrl` and `mediaPath` are
 * not quite inverses, and an earlier version of this comment claimed they were.
 * `mediaUrl` normalises `\` to `/` and `mediaPath` never puts it back, so on
 * Windows the dialog hands over `C:\clips\loop.mp4`, the renderer asks for
 * `C:/clips/loop.mp4`, and the raw string is not in the set: a 403 on every
 * file the operator legitimately opened. `mediaUrl.test.ts` asserts that
 * round-trip, so the disproof was already sitting in the repo.
 *
 * Dormant today — the app is macOS, where the two forms are identical — and
 * fixed here rather than left for whoever packages for Windows to rediscover
 * as "the app refuses every clip". Running the path through the same pair the
 * renderer will means the set holds whatever the handler is going to compute,
 * whatever that pair does to it. `pathToFileURL` accepts the forward-slash form
 * on Windows, so serving is unaffected.
 */
function servedForm(path: string): string {
  return mediaPath(mediaUrl(path)) ?? path
}

async function chooseMedia(): Promise<string[]> {
  // A test seam, in the same family as the DDF_ADDRESS / DDF_PORT / DDF_PYTHON
  // overrides `Sidecar` already reads. The wire gate has to get a cue into the
  // stack, and a native file dialog cannot be driven from a script — so with
  // this set, the picker returns these paths instead of opening. Without it,
  // nothing about the dialog changes.
  const seeded = process.env.DDF_PICK_MEDIA
  if (seeded !== undefined && seeded.length > 0) return seeded.split(delimiter)

  const result = await dialog.showOpenDialog({
    title: 'Add media cues',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Video files',
        // Narrower than what `mapper play` can decode, and deliberately so —
        // playback here is Chromium's, not ffmpeg's. See `mediaFormats.ts`.
        extensions: [...PICKER_EXTENSIONS],
      },
    ],
  })
  return result.canceled ? [] : result.filePaths
}

void app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension')

  // The other half of `mediaUrl.ts`. `net.fetch` over a `file://` URL is what
  // serves the bytes. It does *not* honour range requests — an earlier draft of
  // this comment claimed it did, and the measurement says otherwise: a request
  // carrying `Range: bytes=0-` comes back `200` with the whole file and no
  // `Content-Range`. Seeking works anyway because Chromium buffers the response
  // it was given, which is fine for clips and would not be for a long file.
  //
  // A URL that does not decode to a path gets a 400 rather than a guess, and a
  // path the operator never chose gets a 403. See `allowedMedia`: this handler
  // is reachable from anything running in the page, so "is this URL well
  // formed" is not the question — "did a human ask for this file" is.
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const path = mediaPath(request.url)
    if (path === null) return new Response('bad media url', { status: 400 })
    if (!allowedMedia.has(path)) return new Response('not an opened file', { status: 403 })

    const file = await net.fetch(pathToFileURL(path).toString())
    // The response half of the CORS pair set up in `registerSchemesAsPrivileged`.
    // Electron 43 was measured to let a `corsEnabled` scheme through without
    // this header, but that is a shortcut in its protocol layer rather than
    // anything the CORS algorithm promises, and the failure if a future version
    // stops taking it is the silent one this whole comment exists about. The
    // header makes the response correct by the algorithm. `*` is the right value
    // and not a loosening: the request is `crossOrigin = 'anonymous'`, so it
    // carries no credentials, and the bytes are ones the renderer named itself.
    const headers = new Headers(file.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(file.body, { status: file.status, statusText: file.statusText, headers })
  })

  sidecar = new Sidecar({
    isPackaged: app.isPackaged,
    repoRoot,
    type: currentFloor.type,
    cols: currentFloor.tileCols,
    rows: currentFloor.tileRows,
    blackFrame: currentBlackFrame,
    onStatus: publishStatus,
  })
  sidecar.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterStop) return

  event.preventDefault()
  if (stopInProgress) return
  stopInProgress = true

  void (async () => {
    await withSidecar(async () => { await sidecar?.stop() })
    quitAfterStop = true
    app.quit()
  })()
})
