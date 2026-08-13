import { contextBridge, ipcRenderer } from 'electron'
import type { LinkStatus } from './sidecar.js'

export interface DdfApi {
  writeFrame(frame: Uint8Array): void
  onStatus(callback: (status: LinkStatus) => void): () => void
  pickMedia(): Promise<string[]>
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
}

contextBridge.exposeInMainWorld('ddf', api)

declare global {
  interface Window {
    ddf: DdfApi
  }
}
