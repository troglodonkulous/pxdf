import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The one failure the rest of this app cannot report on its own.
 *
 * React catches an exception thrown during render or commit, unmounts the tree
 * below it, and — with no boundary — renders nothing. It does not rethrow to
 * `window.onerror`, so the preload's handlers never see it either. What the
 * operator gets is a black window, and what the floor gets is worse: the render
 * loop lives in an effect inside `App`, so unmounting runs its cleanup,
 * `cancelAnimationFrame` fires, `writeFrame` is never called again, and
 * `Sidecar` holds the last frame on the wire for ever.
 *
 * Every indicator in the app then reads healthy — the status pill says
 * `sending` and is correct, the Python child is fine, the wire carries a valid
 * non-black frame — while the show is frozen. `electron/frameWatch.ts` is the
 * other half of this: it notices the frames stopping from the main process,
 * which is the only place that can notice if the renderer is too broken to
 * report anything. This half names the cause, which the watchdog cannot.
 *
 * Mounted OUTSIDE `<App>` in `main.tsx`. Inside it, the failure would unmount
 * the boundary along with everything else.
 */
interface State {
  readonly message: string | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is the whole value of catching here rather than
    // letting the watchdog report a frozen floor two seconds later: it names
    // which surface threw. `window.pxdf` is reached defensively because a
    // preload that failed to load is itself a way to get here, and a reporting
    // path that throws inside `componentDidCatch` replaces a diagnosable
    // failure with an undiagnosable one.
    window.pxdf?.log(
      'ERROR',
      'renderer',
      `React tree unmounted — the render loop has stopped and the floor is holding its last frame\n` +
      `${error.name}: ${error.message}\n${error.stack ?? ''}\n` +
      `component stack:${info.componentStack ?? ' (none)'}`,
    )
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children

    // Deliberately plain, and deliberately not offering a retry. Re-mounting
    // would rebuild the show from `INITIAL_SHOW` and drop every cue the
    // operator had loaded, which mid-show is a second failure dressed as a
    // recovery. Restarting the app is the honest instruction, and the sentence
    // about the floor is there because the operator's first question — looking
    // at a floor that is still lit — is whether anything is still being sent.
    return (
      <div className="error-banner" role="alert" style={{ margin: 'var(--sp-6)' }}>
        <strong>The player stopped.</strong> The floor is holding its last frame and nothing new
        is being drawn. Quit and reopen the app; the log has the details.
        <div style={{ marginTop: 'var(--sp-4)', opacity: 0.8 }}>{this.state.message}</div>
      </div>
    )
  }
}
