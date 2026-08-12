import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, powerSaveBlocker } from 'electron'
import { SHOP_RIG } from '../src/render/geometry.js'
import { blackFrame } from '../src/render/onePass.js'
import { Sidecar, type LinkStatus } from './sidecar.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDirectory, '../..')

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
    width: 920,
    height: 620,
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

void app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension')

  sidecar = new Sidecar({
    isPackaged: app.isPackaged,
    repoRoot,
    type: SHOP_RIG.type,
    cols: SHOP_RIG.tileCols,
    rows: SHOP_RIG.tileRows,
    blackFrame: blackFrame(SHOP_RIG),
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
