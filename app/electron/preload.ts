import { contextBridge, ipcRenderer } from 'electron'
import type { LinkStatus } from './sidecar.js'

export interface DdfApi {
  writeFrame(frame: Uint8Array): void
  onStatus(callback: (status: LinkStatus) => void): () => void
  pickMedia(): Promise<string[]>
  mapperPlan(type: string, cols: number, rows: number): Promise<string>
  listInterfaces(): Promise<{ name: string; address: string }[]>
  setFloor(floor: { type: string; tileCols: number; tileRows: number }): Promise<void>
  setLocalIp(address: string | undefined): Promise<void>
}

/**
 * The last link status the main process published, held here so a subscriber
 * that arrives late still learns it.
 *
 * This listener is registered while the preload script runs, which is before
 * any page script — and that is the point. `Sidecar` publishes 'linked' when
 * its child spawns and `main.ts` re-publishes on `did-finish-load`, both of
 * which happen before React has mounted and called `onStatus`. Nothing
 * re-published after that, so the indicator sat on its initial 'reconnecting'
 * for the life of the window while the sidecar was healthy and sending 600
 * packets a second.
 *
 * Caching here rather than adding a request channel keeps the main process the
 * only publisher: there is still exactly one path a status travels, and every
 * subscriber sees the same value whenever it happens to subscribe.
 */
let lastStatus: LinkStatus = 'reconnecting'
ipcRenderer.on('ddf:status', (_event: unknown, status: LinkStatus) => { lastStatus = status })

const api: DdfApi = {
  writeFrame(frame) {
    ipcRenderer.send('ddf:frame', frame)
  },
  onStatus(callback) {
    const listener = (_event: unknown, status: LinkStatus): void => callback(status)
    ipcRenderer.on('ddf:status', listener)
    // Replay before returning. A status that arrived before this subscriber
    // existed is not stale news to it — it is the only news there is until the
    // next spawn, which may be hours away or never.
    callback(lastStatus)
    return () => ipcRenderer.removeListener('ddf:status', listener)
  },
  pickMedia() {
    return ipcRenderer.invoke('ddf:pick-media') as Promise<string[]>
  },
  mapperPlan(type, cols, rows) {
    return ipcRenderer.invoke('ddf:mapper-plan', type, cols, rows) as Promise<string>
  },
  listInterfaces() {
    return ipcRenderer.invoke('ddf:list-interfaces') as Promise<{ name: string; address: string }[]>
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
