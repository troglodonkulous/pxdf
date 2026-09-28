import { fileURLToPath, pathToFileURL } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, net, powerSaveBlocker, protocol, shell } from 'electron'
import { floorGeometry, SHOP_RIG } from '../src/render/geometry.js'
import { blackFrame } from '../src/render/onePass.js'
import { PICKER_EXTENSIONS } from '../src/player/mediaFormats.js'
import { MEDIA_SCHEME, mediaPath, mediaUrl } from '../src/player/mediaUrl.js'
import type { Cue, ShowFloor } from '../src/player/show.js'
import { type BannerSource, composeBanner } from './banners.js'
import { frameVerdict } from './frameWatch.js'
import { createLogger, type LogLevel, type Logger } from './log.js'
import { runMapperPlan } from './mapperPlan.js'
import { nicVerdict } from './nicWatch.js'
import { flushSettings, loadSettings, updateSettings } from './settings.js'
import { canonicalDir, listLibraryFiles, servableLibraryFile } from './mediaAuth.js'
import { mapperCwd, resolvePythonEnv } from './paths.js'
import { Sidecar, type SenderStatus } from './sidecar.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const devRepoRoot = resolve(currentDirectory, '../..')

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
let currentSenderError: { message: string } | null = null
let currentFloor: ShowFloor = { type: SHOP_RIG.type, tileCols: SHOP_RIG.tileCols, tileRows: SHOP_RIG.tileRows }
let currentBlackFrame: Uint8Array = blackFrame(SHOP_RIG)
let interfacePollTimer: ReturnType<typeof setInterval> | null = null
let lastInterfaces: { name: string; address: string }[] | null = null
let nicBanner: string | null = null
let pendingNicVerdict: ReturnType<typeof nicVerdict> | null = null
let nicVerdictQueued = false
let quitAfterStop = false
let stopInProgress = false
/**
 * The one folder the Cue Library may list and `ddf-media://` may serve
 * library files from, beyond the individually-picked files in `allowedMedia`.
 * Canonical (realpath'd) or null — see `mediaAuth.ts` for what canonical
 * means here and why it matters against a symlink.
 *
 * DECISION: a persisted `lastMediaDir` DOES re-authorise its folder
 * automatically at launch, with no picker interaction. The alternative —
 * clearing it every launch and re-populating the Library only after a fresh
 * pick — was rejected: the Library exists to repopulate on launch, the same
 * way `localIp` is restored from `settings.ts` rather than re-asked for
 * every time. A folder only ever enters this variable in one of two ways:
 * read back from `settings.json`, which only this process writes and only
 * ever from a value the operator produced by clicking through the native
 * `dialog.showOpenDialog` in some earlier session; or set fresh from
 * `dirname()` of a path that same dialog just returned. The renderer
 * cannot set this value, cannot pass a directory into `ddf:list-media-dir`
 * (it takes no argument — see the handler), and cannot reach a folder this
 * way that the operator did not, at some point, choose a file from through
 * the OS's own picker. Restoring it at launch is re-granting a capability
 * the operator already granted, not handing the untrusted renderer a new
 * one.
 *
 * If the folder has since been renamed, unmounted or deleted,
 * `canonicalDir` returns null and the Library is simply empty until
 * something is picked again — the same "say nothing rather than guess"
 * shape `nicWatch.ts` uses for a NIC that has vanished.
 */
let authorizedMediaDir: string | null = null

/**
 * The log, once `whenReady` has built it.
 *
 * Null before then, and `logLine` tolerates that rather than asserting: module
 * scope runs before `app.getPath` is legal, and a crash *there* is exactly the
 * kind of failure worth reporting — so the reporting path must not itself be
 * the thing that throws. Those few milliseconds are covered by the
 * `uncaughtException` handler's stderr fallback instead.
 */
let logger: Logger | null = null

function logLine(level: LogLevel, source: string, message: string): void {
  logger?.log(level, source, message)
}

/**
 * A main process that threw must not read as one that answered.
 *
 * Installed at module scope rather than inside `whenReady` so it covers the
 * window before the app is ready — which is where a bad `protocol` registration
 * or a settings file that will not parse would land. `logLine` no-ops until the
 * logger exists, so the stderr write below is not a duplicate on that path: it
 * is the only copy.
 *
 * Deliberately not `app.quit()`. Node's default for an uncaught exception is to
 * die, and installing a handler suppresses that — which is the right trade here
 * (a show does not want the app vanishing over a failure in a settings write)
 * but only if the failure is loud. It gets the operator's banner, the log, and
 * stderr.
 */
function reportFatal(kind: string, error: unknown): void {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
    : String(error)
  logLine('FATAL', 'main', `${kind}: ${detail}`)
  process.stderr.write(`ddf: ${kind}: ${detail}\n`)
  setBanner('fatal', `the app hit an internal error — see the log. ${kind}: ${detail.split('\n')[0]}`)
}

process.on('uncaughtException', (error) => reportFatal('uncaught exception', error))
process.on('unhandledRejection', (reason) => reportFatal('unhandled rejection', reason))

function publishStatus(status: SenderStatus): void {
  // On change only. `Sidecar` publishes `restarting` on every spawn and
  // `sending` 400 ms later, which during a crash loop at the bottom of the
  // retry ladder is several transitions a second — a log that recorded each one
  // would bury the death that caused them under the noise it produced.
  if (status !== currentStatus) logLine('INFO', 'sender', `status ${currentStatus} -> ${status}`)
  currentStatus = status
  mainWindow?.webContents.send('ddf:status', status)
}

/**
 * What each source currently has to say, one slot each.
 *
 * See `banners.ts` for the two ways the single shared slot this replaces ate
 * diagnostics — a log-file warning wiped by the first routine sidecar recovery,
 * and a frame watchdog permanently silenced by having its message overwritten.
 * A source writes only its own key, so neither is reachable from here.
 */
const liveBanners: Partial<Record<BannerSource, string>> = {}

function setBanner(source: BannerSource, message: string | null): void {
  // On change only, and per source. The watchdog and the NIC poll are both
  // level-triggered and call this on every tick with the same string for as
  // long as the fault lasts; logging each one would put a line a second behind
  // a banner that never changed.
  if ((liveBanners[source] ?? null) === message) return

  if (message === null) {
    delete liveBanners[source]
    logLine('INFO', source, 'banner cleared')
  } else {
    liveBanners[source] = message
    logLine('ERROR', source, message)
  }

  // The composed line is what the renderer sees; the log above is what the
  // session is graded on. The log gets every source's message in full even when
  // the UI can only show the most urgent one.
  const composed = composeBanner(liveBanners)
  currentSenderError = composed === null ? null : { message: composed }
  mainWindow?.webContents.send('ddf:sender-error', currentSenderError)
}

function listIpv4Interfaces(): { name: string; address: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(({ family, internal }) => family === 'IPv4' && !internal)
      .map(({ address }) => ({ name, address })),
  )
}

function pollInterfaces(): void {
  const interfaces = listIpv4Interfaces()
  const verdict = nicVerdict(
    process.env.DDF_LOCAL_IP,
    interfaces,
    nicBanner,
    liveBanners.nic ?? null,
  )
  // `clearBanner`'s guard — this watcher may take down only its own message —
  // is now also structural, since `setBanner` writes a slot nothing else can
  // reach. It is still consulted rather than deleted because `nicWatch.ts`'s
  // tests are the record of the two regressions that produced it.
  if (verdict.nicBanner !== null) setBanner('nic', verdict.nicBanner)
  else if (verdict.clearBanner) setBanner('nic', null)
  nicBanner = verdict.nicBanner
  queueNicVerdict(verdict)

  // Interface order comes from the OS and is stable within a process. Treating
  // an order change as a change is harmless, while sorting would make the UI's
  // presentation differ from the native enumeration used by the picker.
  if (JSON.stringify(interfaces) !== JSON.stringify(lastInterfaces)) {
    // A cable going in or out, timestamped. At a venue this is the line that
    // separates "the sender died" from "somebody moved a cable while it was
    // running", and those have entirely different next steps.
    logLine(
      'INFO',
      'nic',
      `interfaces: ${interfaces.map(({ name, address }) => `${name}=${address}`).join(' ') || '(none)'}`,
    )
    lastInterfaces = interfaces
    mainWindow?.webContents.send('ddf:interfaces', interfaces)
  }
}

function startInterfacePoll(): void {
  if (interfacePollTimer !== null) return
  // Once straight away, not only on the first tick. Launching with the cable
  // already out is the ordinary case — the laptop boots at the venue before
  // anyone patches it — and waiting 2 s to notice buys two seconds of a sender
  // crash-looping against an address that was never going to be there.
  pollInterfaces()
  interfacePollTimer = setInterval(pollInterfaces, 2_000)
}

function stopInterfacePoll(): void {
  if (interfacePollTimer === null) return
  clearInterval(interfacePollTimer)
  interfacePollTimer = null
}

/**
 * Renderer liveness, and the log's own heartbeat.
 *
 * See `frameWatch.ts` for what this is watching for and why nothing else in the
 * app can see it. This half owns the two things a pure function cannot: the
 * clock, and the rule that the banner is published on the *edge* rather than
 * every tick.
 *
 * The heartbeat is the positive control for the whole log file. Without it,
 * "the log contains no errors" and "the app died twenty minutes ago" produce
 * byte-identical evidence, and `CLAUDE.md`'s rule that silence must be
 * distinguishable from success is broken by the instrument rather than by the
 * thing it measures. One line a minute carrying the frame count is what makes a
 * gap in the timestamps mean something.
 */
let frameWatchTimer: ReturnType<typeof setInterval> | null = null
let lastFrameAt: number | null = null
let windowReadyAt: number | null = null
let watchdogBanner: string | null = null
let framesSinceHeartbeat = 0
let ticksSinceHeartbeat = 0

const HEARTBEAT_TICKS = 60

/**
 * Is the log still recording?
 *
 * Called at launch *and* on every watchdog tick, because whether the log works
 * is not a launch-time property. The volume it lives on can fill, a managed
 * profile can revoke the folder, an external disk can be unplugged — and from
 * that moment every line this app writes goes only to a stderr that a packaged
 * `.app` launched from Finder has nowhere to put.
 *
 * Checked once at startup, a log that dies at 21:40 reads exactly like one that
 * is fine, which is this project's own failure mode with the instrument as the
 * subject. It is also the assumption `composeBanner` rests on: `(+2 more)` is a
 * pointer at the log file, and it would go on pointing at a file that stopped
 * recording hours ago.
 *
 * Never cleared, because `writeError` latches. A log that failed a write and
 * then recovered has a hole in it, and a hole is not something the operator can
 * see by reading what did get written.
 */
function checkLogHealth(): void {
  if (logger === null) {
    setBanner('log', 'no log file this session — the log folder could not be created')
  } else if (logger.writeError !== null) {
    setBanner('log', `the log is not recording — ${logger.writeError}`)
  }
}

function checkFrames(): void {
  checkLogHealth()

  const verdict = frameVerdict({
    lastFrameAt,
    windowReadyAt,
    now: Date.now(),
    lastWatchdogBanner: watchdogBanner,
    currentBanner: liveBanners.watchdog ?? null,
  })

  // Edge-triggered publish over a level-triggered verdict. The message carries
  // no elapsed counter precisely so this comparison works — see the
  // "keeps the message byte-identical" test in `frameWatch.test.ts`.
  if (verdict.banner !== null) setBanner('watchdog', verdict.banner)
  else if (verdict.clearBanner) setBanner('watchdog', null)
  watchdogBanner = verdict.watchdogBanner

  ticksSinceHeartbeat += 1
  if (ticksSinceHeartbeat >= HEARTBEAT_TICKS) {
    logLine(
      'INFO',
      'heartbeat',
      `status=${currentStatus} nic=${process.env.DDF_LOCAL_IP ?? 'default'} ` +
      `floor=${currentFloor.type} ${currentFloor.tileCols}x${currentFloor.tileRows} ` +
      `frames=${framesSinceHeartbeat}/${HEARTBEAT_TICKS}s`,
    )
    ticksSinceHeartbeat = 0
    framesSinceHeartbeat = 0
  }
}

function startFrameWatch(): void {
  if (frameWatchTimer !== null) return
  frameWatchTimer = setInterval(checkFrames, 1_000)
}

function stopFrameWatch(): void {
  if (frameWatchTimer === null) return
  clearInterval(frameWatchTimer)
  frameWatchTimer = null
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

function queueNicVerdict(verdict: ReturnType<typeof nicVerdict>): void {
  pendingNicVerdict = verdict
  if (nicVerdictQueued) return
  nicVerdictQueued = true

  // A sidecar stop can occupy the lifecycle queue longer than the 2 s poll
  // interval. Queueing every tick would grow an unbounded tail of stale
  // suspend/resume calls; dropping overlapping ticks could instead suspend a
  // replacement after its NIC had returned. One queued operation reads the
  // newest verdict when it reaches the sidecar, so delay changes neither the
  // final state nor the amount of work waiting behind it.
  void withSidecar(async () => {
    const latestSuspend = pendingNicVerdict?.suspend
    pendingNicVerdict = null
    if (latestSuspend === undefined) return
    if (latestSuspend !== null) sidecar?.suspend(latestSuspend)
    else sidecar?.resume()
  }).then(
    () => { nicVerdictQueued = false },
    (error: unknown) => {
      nicVerdictQueued = false
      // Was the last `console.error` in the app, which is the reason this
      // branch exists: a suspend or resume that never reached the sender
      // leaves the banner and the wire disagreeing, and a packaged `.app`
      // launched from Finder has no stdout anyone will ever read.
      logLine('ERROR', 'nic', `failed to apply NIC state to sender: ${String(error)}`)
    },
  )
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
    repoRoot: mapperCwd(app.isPackaged, devRepoRoot),
    type: next.type,
    cols: next.tileCols,
    rows: next.tileRows,
    blackFrame: black,
    onStatus: publishStatus,
    onError: (message: string | null) => setBanner('sender', message),
    onLog: (level, message) => logLine(level, 'sidecar', message),
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
  updateSettings({ localIp: process.env.DDF_LOCAL_IP ?? '' })
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
    if (BrowserWindow.getAllWindows().length === 0) {
      // Disarm the watchdog with the window. Nothing is expected to be drawing
      // once there is no renderer, and a `lastFrameAt` left standing from the
      // closed window would make the *next* one — macOS reopens on `activate` —
      // fire "stopped producing frames" the instant it loads, before it has had
      // a chance to draw anything. A warning that is guaranteed on a path the
      // operator takes deliberately is the cry-wolf failure by construction.
      windowReadyAt = null
      lastFrameAt = null
      watchdogBanner = null
      setBanner('watchdog', null)
      logLine('INFO', 'window', 'last window closed; black frame sent, watchdog disarmed')
      sidecar?.writeFrame(currentBlackFrame)
    }
  })
  window.webContents.on('did-finish-load', () => {
    // Re-armed from scratch on every load, reload included: the grace period is
    // measured from when this page started, not from when the app did.
    windowReadyAt = Date.now()
    lastFrameAt = null
    watchdogBanner = null
    setBanner('watchdog', null)
    logLine('INFO', 'window', 'renderer loaded')
    publishStatus(currentStatus)
    window.webContents.send('ddf:sender-error', currentSenderError)
    if (lastInterfaces !== null) window.webContents.send('ddf:interfaces', lastInterfaces)
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(currentDirectory, 'index.html'))
  }
}

ipcMain.on('ddf:frame', (_event: unknown, frame: Uint8Array) => {
  // Two counters and nothing else. This runs 30-60 times a second, so it is the
  // one handler in the app that must never log, never allocate and never call
  // into the verdict — `checkFrames` reads what this leaves behind, once a
  // second, on its own timer.
  lastFrameAt = Date.now()
  framesSinceHeartbeat += 1
  sidecar?.writeFrame(frame)
})

ipcMain.on('ddf:log', (_event: unknown, level: LogLevel, source: string, message: string) => {
  logLine(level, source, message)
})

ipcMain.on('ddf:reveal-log', () => {
  if (logger !== null) shell.showItemInFolder(logger.path)
})

ipcMain.handle('ddf:mapper-plan', (_event, type: string, cols: number, rows: number) => {
  return runMapperPlan(type, cols, rows, app.isPackaged)
})

ipcMain.handle('ddf:list-interfaces', () => {
  return listIpv4Interfaces()
})

ipcMain.handle('ddf:get-local-ip', () => process.env.DDF_LOCAL_IP ?? '')
ipcMain.handle('ddf:set-floor', (_event, floor: ShowFloor) => setFloor(floor))
ipcMain.handle('ddf:set-local-ip', (_event, address: string | undefined) => setLocalIp(address))
ipcMain.handle('ddf:list-media-dir', (): { dir: string; files: string[] } | null => {
  if (authorizedMediaDir === null) return null
  return { dir: authorizedMediaDir, files: listLibraryFiles(authorizedMediaDir, PICKER_EXTENSIONS) }
})

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
  if (chosen.length > 0) {
    const dir = canonicalDir(dirname(chosen[0]))
    if (dir !== null) {
      authorizedMediaDir = dir
      updateSettings({ lastMediaDir: dir })
    }
  }
  return chosen
})

ipcMain.handle('ddf:cue-seed', (): Record<string, Pick<Cue, 'loop' | 'trimStartMs' | 'trimEndMs'>> => {
  const raw = process.env.DDF_CUE_SEED
  if (raw === undefined || raw.length === 0) return {}
  try {
    return JSON.parse(raw) as Record<string, Pick<Cue, 'loop' | 'trimStartMs' | 'trimEndMs'>>
  } catch {
    // A malformed hand-written test seed must not abort application launch.
    return {}
  }
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
    defaultPath: authorizedMediaDir ?? app.getPath('downloads'),
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
  // First, before anything that can fail. `app.getPath('logs')` is only legal
  // once the app is ready, which is why this is here and not at module scope —
  // and everything below it is something worth having a record of.
  //
  // Guarded, and the guard is the point. `createLogger` can throw on its
  // `mkdirSync` — a managed profile, a full disk, a `~/Library/Logs` that is
  // not writable — and this call sits inside `whenReady().then(...)`, so an
  // escape would reject that promise and skip everything after it: no sidecar,
  // no window, no interface poll. The app would fail to start *because* of the
  // thing added to explain failures, which is the instrument breaking what it
  // was installed to measure. Running without a log is a bad session; running
  // without a floor is no session at all.
  try {
    logger = createLogger(app.getPath('logs'))
  } catch (error) {
    process.stderr.write(`ddf: no log this session: ${String(error)}\n`)
  }

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
    const servable = allowedMedia.has(path)
      ? path
      : servableLibraryFile(path, authorizedMediaDir, PICKER_EXTENSIONS)
    if (servable === null) return new Response('not an opened file', { status: 403 })

    const file = await net.fetch(pathToFileURL(servable).toString())
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

  // The stored NIC seeds the environment, and an explicit `DDF_LOCAL_IP` still
  // wins — the wire gate and `npm run dev:floor` both set it, and a stored
  // preference must not quietly override what the operator typed on the command
  // line. If the stored address is not on this machine any more, the interface
  // poll started below notices within the first tick and says so; that is a
  // better outcome than dropping the preference here, which would leave the
  // dropdown pointing somewhere plausible and wrong.
  //
  // Written out rather than as `??=`, which does not do what it looks like it
  // does here: `process.env` stringifies whatever it is assigned, so
  // `process.env.X ??= undefined` sets X to the literal string "undefined".
  // That reached the sidecar as `--local-ip undefined`, the bind failed, and
  // the poll below then correctly suspended a sender that could never work —
  // silencing the whole wire gate. The failure was loud and immediate, which
  // is the only reason it cost minutes instead of a session.
  const storedSettings = loadSettings()
  if (process.env.DDF_LOCAL_IP === undefined && storedSettings.localIp.length > 0) {
    process.env.DDF_LOCAL_IP = storedSettings.localIp
  }
  authorizedMediaDir = canonicalDir(storedSettings.lastMediaDir)

  // The launch block, and the reason it is no longer `if (app.isPackaged)`.
  //
  // This used to be a `process.stderr.write` on the packaged path only, on the
  // grounds that it was the one record of which interpreter a `.app` launched
  // from Finder reached for. That reasoning was right and the destination was
  // wrong: a `.app` launched from Finder has no stderr anybody will ever read,
  // so the one record was written to nowhere. It goes in the log now, and
  // unconditionally — the dev build's answers to these questions are worth
  // having in the same file, in the same format, as the packaged build's,
  // because comparing the two is how "it works in dev" gets diagnosed.
  //
  // Everything here is something a sender can fail on and nothing here is
  // visible from the UI afterwards.
  const env = resolvePythonEnv(app.isPackaged)
  logLine('INFO', 'launch', [
    // `app.getName()` and not the literal "ddf": unpackaged, Electron answers
    // "Electron 43.4.0" for both of these, and a line reading "ddf 43.4.0"
    // would be the log confidently misidentifying the build that wrote it —
    // in the one file anyone consults to answer exactly that question.
    `${app.getName()} ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform} ${process.arch}`,
    `packaged=${String(app.isPackaged)}`,
    `mapper cwd: ${mapperCwd(app.isPackaged, devRepoRoot)}`,
    `python: "${process.env.DDF_PYTHON ?? 'python3'}"`,
    `PATH: ${env.PATH ?? ''}`,
    `floor: ${currentFloor.type} ${currentFloor.tileCols}x${currentFloor.tileRows}`,
    `local ip: ${process.env.DDF_LOCAL_IP ?? '(default route)'}`,
    `log: ${logger?.path ?? '(none)'}`,
  ].join('\n'))

  // The logger reporting on itself, and the one message that cannot be trusted
  // to the logger. If there is no file, or the write of the launch block above
  // failed, then saying so *in the log* reaches nobody — so it goes to the
  // operator, before the session that was going to rely on it. The watchdog
  // tick asks the same question every second afterwards.
  checkLogHealth()

  sidecar = new Sidecar({
    isPackaged: app.isPackaged,
    repoRoot: mapperCwd(app.isPackaged, devRepoRoot),
    type: currentFloor.type,
    cols: currentFloor.tileCols,
    rows: currentFloor.tileRows,
    blackFrame: currentBlackFrame,
    onStatus: publishStatus,
    onError: (message: string | null) => setBanner('sender', message),
    onLog: (level, message) => logLine(level, 'sidecar', message),
  })
  sidecar.start()
  createWindow()
  startInterfacePoll()
  startFrameWatch()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  logLine('INFO', 'app', 'quitting')
  stopInterfacePoll()
  stopFrameWatch()
  // Before the early return below, so a NIC changed inside the debounce window
  // and then quit on is still written.
  flushSettings()
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
