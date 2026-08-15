import { contextBridge, ipcRenderer } from 'electron'
import type { SenderStatus } from './sidecar.js'

export interface DdfApi {
  writeFrame(frame: Uint8Array): void
  onStatus(callback: (status: SenderStatus) => void): () => void
  onSenderError(callback: (payload: { message: string } | null) => void): () => void
  onInterfaces(callback: (list: { name: string; address: string }[]) => void): () => void
  pickMedia(): Promise<string[]>
  listMediaDir(): Promise<{ dir: string; files: string[] } | null>
  mapperPlan(type: string, cols: number, rows: number): Promise<string>
  listInterfaces(): Promise<{ name: string; address: string }[]>
  getLocalIp(): Promise<string>
  setFloor(floor: { type: string; tileCols: number; tileRows: number }): Promise<void>
  setLocalIp(address: string | undefined): Promise<void>
}

/**
 * The last sender status the main process published, held here so a subscriber
 * that arrives late still learns it.
 *
 * This listener is registered while the preload script runs, which is before
 * any page script — and that is the point. `Sidecar` publishes 'sending' when
 * its child spawns and `main.ts` re-publishes on `did-finish-load`, both of
 * which happen before React has mounted and called `onStatus`. Nothing
 * re-published after that, so the indicator sat on its initial 'restarting'
 * for the life of the window while the sidecar was healthy and sending 600
 * packets a second.
 *
 * Caching here rather than adding a request channel keeps the main process the
 * only publisher: there is still exactly one path a status travels, and every
 * subscriber sees the same value whenever it happens to subscribe.
 */
let lastStatus: SenderStatus = 'restarting'
ipcRenderer.on('ddf:status', (_event: unknown, status: SenderStatus) => { lastStatus = status })

let lastSenderError: { message: string } | null = null
ipcRenderer.on('ddf:sender-error', (_event: unknown, payload: { message: string } | null) => {
  lastSenderError = payload
})

let lastInterfaces: { name: string; address: string }[] = []
ipcRenderer.on('ddf:interfaces', (_event: unknown, list: { name: string; address: string }[]) => {
  lastInterfaces = list
})

const api: DdfApi = {
  writeFrame(frame) {
    ipcRenderer.send('ddf:frame', frame)
  },
  onStatus(callback) {
    const listener = (_event: unknown, status: SenderStatus): void => callback(status)
    ipcRenderer.on('ddf:status', listener)
    // Replay before returning. A status that arrived before this subscriber
    // existed is not stale news to it — it is the only news there is until the
    // next spawn, which may be hours away or never.
    callback(lastStatus)
    return () => ipcRenderer.removeListener('ddf:status', listener)
  },
  onSenderError(callback) {
    const listener = (_event: unknown, payload: { message: string } | null): void => callback(payload)
    ipcRenderer.on('ddf:sender-error', listener)
    callback(lastSenderError)
    return () => ipcRenderer.removeListener('ddf:sender-error', listener)
  },
  onInterfaces(callback) {
    const listener = (_event: unknown, list: { name: string; address: string }[]): void => callback(list)
    ipcRenderer.on('ddf:interfaces', listener)
    callback(lastInterfaces)
    return () => ipcRenderer.removeListener('ddf:interfaces', listener)
  },
  pickMedia() {
    return ipcRenderer.invoke('ddf:pick-media') as Promise<string[]>
  },
  listMediaDir() {
    return ipcRenderer.invoke('ddf:list-media-dir') as Promise<{ dir: string; files: string[] } | null>
  },
  mapperPlan(type, cols, rows) {
    return ipcRenderer.invoke('ddf:mapper-plan', type, cols, rows) as Promise<string>
  },
  listInterfaces() {
    return ipcRenderer.invoke('ddf:list-interfaces') as Promise<{ name: string; address: string }[]>
  },
  getLocalIp() {
    return ipcRenderer.invoke('ddf:get-local-ip') as Promise<string>
  },
  setFloor(floor) {
    return ipcRenderer.invoke('ddf:set-floor', floor) as Promise<void>
  },
  setLocalIp(address) {
    return ipcRenderer.invoke('ddf:set-local-ip', address) as Promise<void>
  },
}

contextBridge.exposeInMainWorld('ddf', api)

declare global {
  interface Window {
    ddf: DdfApi
  }
}
