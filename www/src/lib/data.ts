// Client-side data loading utilities for Vite
// Replaces the server-side getStaticProps pattern from Next.js

import { getBasePath } from "./basePath"
import { CC2MC2MN } from "@/src/county"
import { PlotParams } from "react-plotly.js"
import { PlotSpec, PlotsDict } from "@/src/lib/plot"

const cache: Record<string, any> = {}

async function fetchJson<T>(path: string): Promise<T> {
    if (cache[path]) return cache[path]
    const basePath = getBasePath()
    const response = await fetch(`${basePath}${path}`)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${path}: ${response.status}`)
    }
    const data = await response.json()
    cache[path] = data
    return data
}

export async function loadCC2MC2MN(): Promise<CC2MC2MN> {
    return fetchJson<CC2MC2MN>('/njdot/cc2mc2mn.json')
}

export async function loadRundate(): Promise<{ rundate: string }> {
    return fetchJson<{ rundate: string }>('/njsp/rundate.json')
}

export async function loadPlot<PP extends PlotParams = PlotParams>(
    spec: PlotSpec,
    dir: string = "/plots"
): Promise<PP> {
    const { id, name, style } = spec
    const plot = await fetchJson<PlotParams>(`${dir}/${name || id}.json`)
    if (style) {
        plot.style = style
    }
    return plot as PP
}

export async function loadPlots(
    specs: PlotSpec[],
    dir: string = "/plots"
): Promise<PlotsDict> {
    const entries = await Promise.all(
        specs.map(async spec => {
            const plot = await loadPlot(spec, dir)
            return [spec.id, plot] as const
        })
    )
    return Object.fromEntries(entries)
}

// Counties list derived from cc2mc2mn
export async function loadCounties(): Promise<string[]> {
    const cc2mc2mn = await loadCC2MC2MN()
    return Object.values(cc2mc2mn).map(({ cn }) => cn)
}
