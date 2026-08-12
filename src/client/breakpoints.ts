/**
 * Narrow-viewport ("mobile") breakpoint for the sidebar. Width-based, shared
 * by the layout logic (JS) and the style gates (CSS). The CSS side pairs
 * with this file via `@media (max-width: 1023px)` rules (sidebar.module.css)
 * — 1023px ≡ widths below NARROW_MAX_WIDTH, documented at both ends.
 *
 * The value matches the DSH app shell's own narrow breakpoint
 * (SIDEBAR_AUTO_COLLAPSE = 1024, ui-layout/columns.ts), so the sidebar's
 * mobile layout switches at exactly the width where the host app collapses
 * its own sidebar to the rail.
 */
import { useEffect, useState } from 'react'

/** Viewport widths strictly below this are "mobile" (paired CSS: max-width: 1023px). */
export const NARROW_MAX_WIDTH = 1024

/** Whether a viewport width is narrow (mobile). */
export function isNarrowWidth(width: number): boolean {
  return width < NARROW_MAX_WIDTH
}

/**
 * Live narrow-viewport flag for components. Reads `window.innerWidth` and
 * re-measures on resize (rAF-throttled, the repo's existing drag pattern).
 * Deliberately avoids `matchMedia` (jsdom does not implement it) — the
 * resize listener is equally exact for a breakpoint that never changes
 * while the page is open.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && isNarrowWidth(window.innerWidth),
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      setNarrow(isNarrowWidth(window.innerWidth))
    }
    const onResize = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  return narrow
}
