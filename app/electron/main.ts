import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker } from 'electron'
import { SHOP_RIG } from '../src/render/geometry.js'
import { blackFrame } from '../src/render/onePass.js'
import { Sidecar, type LinkStatus } from './sidecar.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDirectory, '../..')
const BLACK_FRAME = blackFrame(SHOP_RIG)

let mainWindow: BrowserWindow | null = null
let sidecar: Sidecar | null = null
let currentStatus: LinkStatus = 'reconnecting'
let quitAfterStop = false
let stopInProgress = false

function publishStatus(status: LinkStatus): void {
  currentStatus = status
  mainWindow?.webContents.send('ddf:status', status)
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
    // vendor's own content.
    if (BrowserWindow.getAllWindows().length === 0) sidecar?.writeFrame(BLACK_FRAME)
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

ipcMain.handle('ddf:pick-media', async (): Promise<string[]> => {
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
        extensions: ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'mpg', 'mpeg'],
      },
    ],
  })
  return result.canceled ? [] : result.filePaths
})

void app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension')

  sidecar = new Sidecar({
    isPackaged: app.isPackaged,
    repoRoot,
    type: SHOP_RIG.type,
    cols: SHOP_RIG.tileCols,
    rows: SHOP_RIG.tileRows,
    blackFrame: BLACK_FRAME,
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
    await sidecar?.stop()
    quitAfterStop = true
    app.quit()
  })()
})
