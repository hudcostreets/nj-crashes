/** Basemap style + severity palette shared by the full crash map (`CrashMap`) and the small
 *  embedded maps (`MiniMap`: crash detail page, road page). */
import React, { useCallback, useMemo, useRef, useState } from "react"

export type Severity = "f" | "i" | "p"
export type Rgb = [number, number, number]
export type Rgba = [number, number, number, number]

const STADIA_ATTRIBUTION = '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/** Stadia auth. `api_key` is a *non-browser* credential — it's not domain-
 *  restrictable, so anyone can lift it from the bundle and reuse it. We
 *  therefore only ship it in **dev builds** (where it's needed to reach Stadia
 *  from `m3`; `localhost` "just works" keyless). **Prod relies on browser-
 *  enforced domain auth** — register the prod hosts in the Stadia dashboard
 *  (`*.hudcostreets.org` ✓; add `*.hccs.dev` for `crashes.hccs.dev`). */
const STADIA_TOKEN = import.meta.env.DEV
    ? ((import.meta.env.VITE_STADIA_TOKEN as string | undefined) || "")
    : ""

export const BASEMAP_SOURCE = "stadia"

export function rasterStyle(theme: "light" | "dark"): any {
    const slug = theme === "dark" ? "alidade_smooth_dark" : "alidade_smooth"
    const key = STADIA_TOKEN ? `?api_key=${STADIA_TOKEN}` : ""
    return {
        version: 8,
        sources: {
            [BASEMAP_SOURCE]: {
                type: "raster",
                tiles: [`https://tiles.stadiamaps.com/tiles/${slug}/{z}/{x}/{y}@2x.png${key}`],
                tileSize: 256,
                attribution: STADIA_ATTRIBUTION,
            },
        },
        layers: [{ id: BASEMAP_SOURCE, type: "raster", source: BASEMAP_SOURCE }],
    }
}

/** The HTTP status of a MapLibre `error` event if it's a basemap tile the server *refused*
 *  (401/403), else `null`. Stadia's browser domain auth answers an unregistered host (e.g. a
 *  `*.workers.dev` preview) with 401 on every tile; MapLibre just logs each one, leaving a blank
 *  map under the deck.gl layers. */
export function basemapAuthStatus(e: { error?: unknown; sourceId?: string }): number | null {
    if (e.sourceId !== undefined && e.sourceId !== BASEMAP_SOURCE) return null
    const status = (e.error as { status?: unknown } | undefined)?.status
    return status === 401 || status === 403 ? status : null
}

/** Basemap style for `theme`, plus an `onError` for `<Map>` that records a refused basemap
 *  (see `basemapAuthStatus`) so the map can say so instead of silently rendering blank. */
export function useBasemap(theme: "light" | "dark") {
    const style = useMemo(() => rasterStyle(theme), [theme])
    const [refused, setRefused] = useState<number | null>(null)
    const warned = useRef(false)
    const onError = useCallback((e: { error?: unknown; sourceId?: string }) => {
        const status = basemapAuthStatus(e)
        if (status === null) return
        if (!warned.current) {
            warned.current = true
            console.warn(
                `Basemap tiles refused (HTTP ${status}): Stadia doesn't authorize "${location.hostname}". ` +
                `Add it to the property's domains in the Stadia dashboard (client.stadiamaps.com).`,
            )
        }
        setRefused(status)
    }, [])
    return { style, onError, refused }
}

/** Visible notice for a refused basemap (see `useBasemap`), bottom-left beside the ⓘ badge. */
export function BasemapNotice({ refused, theme }: { refused: number | null; theme: "light" | "dark" }) {
    if (refused === null) return null
    return (
        <div
            role="status"
            style={{
                position: "absolute", bottom: 8, left: 34, zIndex: 50,
                background: theme === "dark" ? "rgba(30,30,30,0.9)" : "rgba(255,255,255,0.9)",
                color: theme === "dark" ? "#f0b0a0" : "#a03020",
                border: `1px solid ${theme === "dark" ? "#444" : "#ccc"}`, borderRadius: 4,
                padding: "1px 6px", fontSize: "0.72em", lineHeight: "18px", whiteSpace: "nowrap",
                pointerEvents: "none",
            }}
        >
            Basemap unavailable: tile server refused this site ({refused})
        </div>
    )
}

export const SEVERITY_COLOR: Record<Severity, Rgb> = {
    f: [239, 68, 68],
    i: [245, 158, 11],
    p: [220, 200, 90],
}

export function severityRgba(sev: Severity, alpha = 200): Rgba {
    const [r, g, b] = SEVERITY_COLOR[sev]
    return [r, g, b, alpha]
}

/** Compact "ⓘ" badge in the bottom-left that reveals the tile attribution on
 *  hover. Replaces MapLibre's default AttributionControl (disabled) with
 *  something less screenshot-noisy while still honoring Stadia's attribution
 *  terms (https://stadiamaps.com/docs/attribution). */
export function AttributionPopover({ theme }: { theme: "light" | "dark" }) {
    const [open, setOpen] = useState(false)
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const border = `1px solid ${theme === "dark" ? "#444" : "#ccc"}`
    const linkStyle: React.CSSProperties = { color: fg, textDecoration: "underline" }
    return (
        <div
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            style={{ position: "absolute", bottom: 8, left: 8, zIndex: 50 }}
        >
            <button
                type="button"
                aria-label="Map attribution"
                onClick={() => setOpen(o => !o)}
                style={{
                    background: bg, color: fg, border, borderRadius: 4,
                    width: 20, height: 20, padding: 0, fontSize: "0.75em",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                }}
            >ⓘ</button>
            {open && (
                <div style={{
                    position: "absolute", bottom: "100%", left: 0,
                    background: bg, color: fg, border, borderRadius: 4,
                    padding: "4px 8px", fontSize: "0.72em", whiteSpace: "nowrap",
                    pointerEvents: "auto",
                }}>
                    © <a href="https://stadiamaps.com/" style={linkStyle}>Stadia Maps</a>
                    {" · "}
                    <a href="https://openmaptiles.org/" style={linkStyle}>OpenMapTiles</a>
                    {" · "}
                    <a href="https://www.openstreetmap.org/copyright" style={linkStyle}>OpenStreetMap</a>
                </div>
            )}
        </div>
    )
}
