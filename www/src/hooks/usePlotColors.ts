import { useCallback, useEffect, useState } from 'react'

export type PlotColors = {
  plotBg: string
  paperBg: string
  gridColor: string
  textColor: string
  legendBg: string
}

function computePlotColors(): PlotColors {
  if (typeof document === 'undefined') {
    return {
      plotBg: 'white',
      paperBg: 'white',
      gridColor: '#ddd',
      textColor: '#333',
      legendBg: 'white',
    }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    plotBg: style.getPropertyValue('--plot-bg').trim() || 'white',
    paperBg: style.getPropertyValue('--bg-primary').trim() || 'white',
    gridColor: style.getPropertyValue('--plot-grid').trim() || '#ddd',
    textColor: style.getPropertyValue('--text-primary').trim() || '#333',
    legendBg: style.getPropertyValue('--bg-secondary').trim() || 'white',
  }
}

export function usePlotColors(): PlotColors {
  const [colors, setColors] = useState(computePlotColors)

  useEffect(() => {
    const updateColors = () => setColors(computePlotColors())

    // Watch for theme changes
    const observer = new MutationObserver(updateColors)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    // Also update on mount in case theme was set before observer
    updateColors()

    return () => observer.disconnect()
  }, [])

  return colors
}
