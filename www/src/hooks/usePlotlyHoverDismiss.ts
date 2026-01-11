import { useEffect, useRef, useCallback } from 'react'

/**
 * Hook to dismiss Plotly hover tooltips when clicking outside the plot area.
 * Provides standard tooltip behavior: click anywhere outside to dismiss.
 *
 * @param plotContainerRef - Ref to the container element holding the Plotly chart
 * @param enabled - Whether the dismiss behavior is enabled (default: true)
 *
 * @returns setupHoverDismiss - Call this in onAfterPlot to set up listeners
 *
 * @example
 * ```tsx
 * const plotContainerRef = useRef<HTMLDivElement>(null)
 * const setupHoverDismiss = usePlotlyHoverDismiss(plotContainerRef)
 *
 * return (
 *   <div ref={plotContainerRef}>
 *     <Plot onAfterPlot={setupHoverDismiss} ... />
 *   </div>
 * )
 * ```
 */
export function usePlotlyHoverDismiss(
  plotContainerRef: React.RefObject<HTMLElement | null>,
  enabled = true
) {
  const stateRef = useRef<{ plotEl: HTMLElement | null, cleanup: (() => void) | null }>({
    plotEl: null,
    cleanup: null,
  })

  // Cleanup on unmount
  useEffect(() => {
    return () => { stateRef.current.cleanup?.() }
  }, [])

  const setupHoverDismiss = useCallback(() => {
    if (!enabled) return

    const container = plotContainerRef.current
    if (!container) return

    const plotEl = container.querySelector('.js-plotly-plot') as HTMLElement | null
    if (!plotEl) return

    // Already set up for this element
    if (stateRef.current.plotEl === plotEl) return

    // Clean up previous listener
    stateRef.current.cleanup?.()
    stateRef.current.plotEl = plotEl

    // Dismiss hover on clicks outside the plot area (standard tooltip behavior)
    const handlePointerUp = (e: TouchEvent | MouseEvent) => {
      const target = e.target as HTMLElement

      // Check if hover is currently visible (works for all hover modes)
      const hoverLayer = plotEl.querySelector('.hoverlayer')
      const hasVisibleHover = hoverLayer && hoverLayer.children.length > 0
      if (!hasVisibleHover) return

      // Don't dismiss if clicking on the hover tooltip itself
      if (hoverLayer?.contains(target)) return

      // Don't dismiss if clicking in the plot area - let Plotly show hover at new position
      const dragLayer = plotEl.querySelector('.nsewdrag')
      if (dragLayer?.contains(target)) return

      // Click outside plot area - dismiss hover
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Plotly = (window as any).Plotly
      if (Plotly?.Fx?.unhover) {
        Plotly.Fx.unhover(plotEl)
      } else {
        // Fallback: clear hover layer directly (for lazy-loaded Plotly)
        while (hoverLayer.firstChild) {
          hoverLayer.removeChild(hoverLayer.firstChild)
        }
      }
    }

    // Listen on document to catch clicks anywhere (standard tooltip behavior)
    document.addEventListener('touchend', handlePointerUp)
    document.addEventListener('mouseup', handlePointerUp)

    stateRef.current.cleanup = () => {
      document.removeEventListener('touchend', handlePointerUp)
      document.removeEventListener('mouseup', handlePointerUp)
    }
  }, [enabled, plotContainerRef])

  return setupHoverDismiss
}
