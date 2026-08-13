import type { SenderStatus } from '../electron/sidecar.js'

/**
 * What the sender process is doing, in the title bar of both surfaces.
 *
 * One component rather than two, because it was two: the JSX and the label
 * switch were byte-identical in `PlayScreen` and `MappingScreen`, which is a
 * pair that stays in step right up until somebody rewords one of them.
 *
 * It says nothing about the floor, and that is deliberate — see `SenderStatus`
 * in `electron/sidecar.ts` for why nothing here could.
 */
export function StatusPill({ status }: { readonly status: SenderStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {label(status)}
    </span>
  )
}

function label(status: SenderStatus): string {
  switch (status) {
    case 'sending': return 'Sending'
    case 'restarting': return 'Restarting'
    case 'stopped': return 'Stopped'
  }
}
