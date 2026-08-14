import { useEffect } from 'react'

/**
 * Escape closes an open `popover="auto"` element, which the platform does not
 * do on its own — measured on this Electron build (see the identical note
 * this was extracted from in MappingScreen.tsx's `NetworkHelp`). Click-outside
 * dismissal is free with `popover="auto"`; this is the other half.
 */
export function usePopoverEscape(popoverId: string): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const panel = document.getElementById(popoverId)
      if (panel instanceof HTMLElement && panel.matches(':popover-open')) panel.hidePopover()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popoverId])
}
