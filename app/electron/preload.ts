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

const api: DdfApi = {
  writeFrame(frame) {
    ipcRenderer.send('ddf:frame', frame)
  },
  onStatus(callback) {
    const listener = (_event: unknown, status: LinkStatus): void => callback(status)
    ipcRenderer.on('ddf:status', listener)
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
