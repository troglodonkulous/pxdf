import { contextBridge, ipcRenderer } from 'electron'
import type { RenderSample } from './renderStats.js'
import type { SenderStatus } from './sidecar.js'
import type { Cue } from '../src/player/show.js'

export interface DdfApi {
  writeFrame(frame: Uint8Array): void
  /** Put a line in the log file. Transitions and faults only — never per frame. */
  log(level: 'INFO' | 'WARN' | 'ERROR', source: string, message: string): void
  /**
   * What the last 250 ms of rendering cost, and how many decoders are open.
   *
   * Sent from the render loop's existing batching tick, four times a second,
   * and folded into the once-a-minute heartbeat by the main process — it writes
   * nothing to the log by itself. See `electron/renderStats.ts`.
   */
  renderStats(sample: RenderSample): void
  /** Show the log file in Finder, so the operator can hand it over. */
  revealLog(): void
  onStatus(callback: (status: SenderStatus) => void): () => void
  onSenderError(callback: (payload: { message: string } | null) => void): () => void
  onInterfaces(callback: (list: { name: string; address: string }[]) => void): () => void
  pickMedia(): Promise<string[]>
  listMediaDir(): Promise<{ dir: string; files: string[] } | null>
  cueSeed(): Promise<Record<string, Pick<Cue, 'loop' | 'trimStartMs' | 'trimEndMs'>>>
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

/**
 * The renderer's last-resort error channels, installed here rather than in React.
 *
 * Preload runs before any page script, which is the whole reason this is not in
 * `main.tsx` or a `useEffect`. The failures worth catching most are the ones
 * that happen before React exists: a bundle that throws at module scope, an
 * asset that 404s, a preload/renderer contract mismatch. A handler React
 * installs cannot see any of them, because React never ran.
 *
 * `ErrorBoundary` is the complement, not a duplicate: it catches what React
 * catches — an exception during render or commit, which React swallows into a
 * blank tree rather than letting reach `window.onerror` — and this catches
 * everything React never sees. Neither covers the other's cases.
 */
window.addEventListener('error', (event: ErrorEvent) => {
  // `event.error` is absent for a resource load failure (an asset 404), where
  // the target rather than the message carries the diagnosis. Reporting only
  // `event.message` there produces the string "Script error." and nothing else,
  // which is a channel that fires and says nothing.
  const target = event.target as { src?: string; href?: string } | null
  const resource = target?.src ?? target?.href
  const detail = event.error instanceof Error
    ? `${event.error.name}: ${event.error.message}\n${event.error.stack ?? ''}`
    : resource !== undefined
      ? `failed to load ${resource}`
      : `${event.message} (${event.filename}:${event.lineno})`
  ipcRenderer.send('ddf:log', 'ERROR', 'renderer', `uncaught: ${detail}`)
}, true)

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason: unknown = event.reason
  const detail = reason instanceof Error
    ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
    : String(reason)
  ipcRenderer.send('ddf:log', 'ERROR', 'renderer', `unhandled rejection: ${detail}`)
})

const api: DdfApi = {
  writeFrame(frame) {
    ipcRenderer.send('ddf:frame', frame)
  },
  log(level, source, message) {
    ipcRenderer.send('ddf:log', level, source, message)
  },
  renderStats(sample) {
    ipcRenderer.send('ddf:render-stats', sample)
  },
  revealLog() {
    ipcRenderer.send('ddf:reveal-log')
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
  cueSeed() {
    return ipcRenderer.invoke('ddf:cue-seed') as Promise<Record<string, Pick<Cue, 'loop' | 'trimStartMs' | 'trimEndMs'>>>
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
