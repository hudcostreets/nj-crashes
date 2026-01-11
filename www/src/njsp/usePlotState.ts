import { useCallback, useEffect, useState } from "react"
import { Layout, PlotData } from "plotly.js"
import { getBasePath } from "@/src/lib/basePath"
import { usePlotColors } from "@/src/hooks/usePlotColors"

export type PlotParams = {
    data: PlotData[]
    layout: Partial<Layout>
}

export type LegendHandlers = {
    onLegendClick: (name: string) => boolean
    onLegendDoubleClick: () => boolean
    onLegendMouseOver: (name: string) => boolean
    onLegendMouseOut: () => boolean
}

/**
 * Hook for common plot state management: JSON loading, legend interactions, dark mode colors
 */
export function usePlotState(jsonFile: string) {
    const basePath = getBasePath()
    const plotColors = usePlotColors()
    const [params, setParams] = useState<PlotParams | null>(null)
    const [soloTrace, setSoloTrace] = useState<string | null>(null)
    const [hoverTrace, setHoverTrace] = useState<string | null>(null)

    // Active trace: hover takes precedence over solo
    const activeTrace = hoverTrace ?? soloTrace

    // Load JSON data
    useEffect(() => {
        fetch(`${basePath}/plots/${jsonFile}`)
            .then(res => res.json())
            .then(data => setParams(data))
            .catch(err => console.error(`Failed to load ${jsonFile}:`, err))
    }, [basePath, jsonFile])

    // Legend click: toggle solo mode
    const onLegendClick = useCallback((name: string) => {
        if (soloTrace === name) {
            setSoloTrace(null)
            setHoverTrace(null)
        } else {
            setSoloTrace(name)
        }
        return false
    }, [soloTrace])

    // Legend double-click: reset to show all
    const onLegendDoubleClick = useCallback(() => {
        setSoloTrace(null)
        setHoverTrace(null)
        return false
    }, [])

    // Legend hover: preview solo mode
    const onLegendMouseOver = useCallback((name: string) => {
        setHoverTrace(name)
        return true
    }, [])

    const onLegendMouseOut = useCallback(() => {
        setHoverTrace(null)
        return true
    }, [])

    const legendHandlers: LegendHandlers = {
        onLegendClick,
        onLegendDoubleClick,
        onLegendMouseOver,
        onLegendMouseOut,
    }

    return {
        params,
        activeTrace,
        plotColors,
        legendHandlers,
        soloTrace,
        hoverTrace,
    }
}

/**
 * Common dark mode layout properties
 */
export function getBaseLayout(plotColors: ReturnType<typeof usePlotColors>, height: number): Partial<Layout> {
    return {
        paper_bgcolor: plotColors.paperBg,
        plot_bgcolor: plotColors.plotBg,
        height,
        hovermode: 'x unified',
        hoverlabel: {
            bgcolor: '#1a1a2e',
            bordercolor: plotColors.gridColor,
            font: { color: '#ffffff' },
        },
    }
}

/**
 * Helper to fade a color for greyed-out traces (HSL-based)
 */
export function fadeColor(hexColor: string | undefined): string {
    if (!hexColor) return 'rgba(128,128,128,0.3)'

    // Parse hex to RGB
    const hex = hexColor.replace('#', '')
    let r: number, g: number, b: number
    if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16) / 255
        g = parseInt(hex[1] + hex[1], 16) / 255
        b = parseInt(hex[2] + hex[2], 16) / 255
    } else if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16) / 255
        g = parseInt(hex.slice(2, 4), 16) / 255
        b = parseInt(hex.slice(4, 6), 16) / 255
    } else {
        return 'rgba(128,128,128,0.3)'
    }

    // RGB to HSL
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0, s = 0, l = (max + min) / 2

    if (max !== min) {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
            case g: h = ((b - r) / d + 2) / 6; break
            case b: h = ((r - g) / d + 4) / 6; break
        }
    }

    // Reduce saturation and lightness for faded effect
    s = s * 0.3
    l = Math.max(0.25, l * 0.5)

    // HSL to RGB
    const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1
        if (t > 1) t -= 1
        if (t < 1/6) return p + (q - p) * 6 * t
        if (t < 1/2) return q
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
        return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const nr = Math.round(hue2rgb(p, q, h + 1/3) * 255)
    const ng = Math.round(hue2rgb(p, q, h) * 255)
    const nb = Math.round(hue2rgb(p, q, h - 1/3) * 255)

    return `rgb(${nr}, ${ng}, ${nb})`
}

/**
 * Check if trace name matches active trace (handles 'yy format)
 */
export function isTraceActive(traceName: string, activeTrace: string | null): boolean {
    if (activeTrace === null) return false
    return traceName === activeTrace || `'${traceName.slice(2)}` === activeTrace
}
