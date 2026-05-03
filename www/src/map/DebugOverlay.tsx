/** Picker / hex debug panel for the crash map.
 *
 *  Renders inline in the controls drawer (no fixed positioning). Shows the
 *  active picker plan, h3 resolution metrics (a la h3geo.org), zoom +
 *  meters/pixel, and per-resolution edge / diameter / on-screen pixel
 *  size — exactly the observables you need to diagnose a "chunky" zoom
 *  transition without toggling devtools.
 */
import { getHexagonAreaAvg, getHexagonEdgeLengthAvg, UNITS } from "h3-js"
import type { FetchPlan } from "./v2"
import type { ViewState } from "./CrashMap"

export type Props = {
    /** Live viewport state — drives zoom + lat for meters-per-pixel calc. */
    viewState: ViewState
    /** Picker output (kind, res, shards, reason). May be null while the
     *  manifest is loading. */
    plan: FetchPlan | null
    /** Render-side resolution choice (`pickHexResolutionForPixels`). For
     *  hex prebins this is `max(plan.res, renderRes)` — the prebin floor
     *  bounds how fine the renderer can go. For raw points it's
     *  unconstrained. Optional. */
    renderRes?: number
    /** Effective resolution actually rendered on screen. Optional. */
    effectiveRes?: number
    /** Hex pixel target driving render-side resolution choice. */
    hexPxTarget?: number
    /** Number of rows in the active dataset (Crash[] or StackedHex[]). */
    rowCount?: number
    /** Fetch state — "loading" before first response, "refetching" when a
     *  newer fetch is in flight while older data is still on screen,
     *  "idle" otherwise. */
    fetchState?: "idle" | "loading" | "refetching"
    /** Light/dark theme toggle. */
    theme: "light" | "dark"
}

function metersPerPixel(zoom: number, lat: number): number {
    return 156543.03 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, zoom)
}

function fmtArea(m2: number): string {
    if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`
    if (m2 >= 100) return `${m2.toFixed(0)} m²`
    return `${m2.toFixed(1)} m²`
}

function fmtMeters(m: number): string {
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`
    return `${m.toFixed(1)} m`
}

function fmtRowCount(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`
    return String(n)
}

function planSummary(plan: FetchPlan): string {
    if (plan.kind === "points") return `points × ${plan.shards.length}`
    if (plan.shards === null) return `r${plan.res} single-file`
    return `r${plan.res} × ${plan.shards.length}`
}

export function DebugOverlay({ viewState, plan, renderRes, effectiveRes, hexPxTarget, rowCount, fetchState, theme }: Props) {
    const { latitude, longitude, zoom, pitch, bearing } = viewState
    const mppx = metersPerPixel(zoom, latitude)
    const dark = theme === "dark"
    const fg = dark ? "#e0e0e0" : "#222"
    const dim = dark ? "#888" : "#666"
    const accent = dark ? "#6db3f2" : "#0066cc"

    const planRes = plan && plan.kind === "hex" ? plan.res : undefined
    const showRes = effectiveRes ?? renderRes ?? planRes

    // Show the union of plan / render / effective res, plus their
    // immediate neighbors so the user can sanity-check what the next
    // resolution boundary would look like.
    const baseRess = Array.from(new Set(
        [planRes, renderRes, effectiveRes].filter((r): r is number => typeof r === "number")
    ))
    const ress: number[] = Array.from(new Set(
        baseRess.flatMap(r => [r - 1, r, r + 1]).filter(r => r >= 5 && r <= 12)
    )).sort((a, b) => a - b)

    return (
        <div style={{
            color: fg, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.95em", lineHeight: 1.5,
        }}>
            <div style={{ marginTop: 2, color: dim }}>view</div>
            <div>z=<b style={{ color: fg }}>{zoom.toFixed(2)}</b> · lat=<b style={{ color: fg }}>{latitude.toFixed(4)}</b> · lon=<b style={{ color: fg }}>{longitude.toFixed(4)}</b></div>
            <div>pitch=<b style={{ color: fg }}>{Math.round(pitch)}°</b> · bearing=<b style={{ color: fg }}>{Math.round(bearing)}°</b> · {mppx.toFixed(2)} m/px</div>

            <div style={{ marginTop: 4, color: dim }}>plan</div>
            {plan ? (
                <>
                    <div>
                        <b style={{ color: accent }}>{planSummary(plan)}</b>
                        {fetchState && fetchState !== "idle" && (
                            <span style={{ marginLeft: 8, color: accent, fontStyle: "italic" }}>
                                · {fetchState === "loading" ? "fetching…" : "refetching…"}
                            </span>
                        )}
                    </div>
                    {plan.reason && <div style={{ color: dim, fontStyle: "italic" }}>{plan.reason}</div>}
                </>
            ) : (
                <div style={{ color: dim }}>—</div>
            )}

            {(rowCount !== undefined || hexPxTarget !== undefined) && (
                <>
                    <div style={{ marginTop: 4, color: dim }}>render</div>
                    {rowCount !== undefined && (
                        <div>
                            {plan?.kind === "hex" ? "hexes" : "rows"}:{" "}
                            <b style={{ color: fg }}>{fmtRowCount(rowCount)}</b>
                        </div>
                    )}
                    {hexPxTarget !== undefined && <div>hexPxTarget: <b style={{ color: fg }}>{hexPxTarget}</b> px</div>}
                </>
            )}

            {ress.length > 0 && (
                <>
                    <div style={{ marginTop: 4, color: dim }}>h3 cells</div>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                            <tr style={{ color: dim }}>
                                <th style={{ textAlign: "left", fontWeight: 400, paddingRight: 6 }}>res</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }}>edge</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }}>area</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }} title="hex width on screen (vertex-to-vertex, = 2× edge px)">⌀ px</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ress.map(r => {
                                const edgeM = getHexagonEdgeLengthAvg(r, UNITS.m)
                                const areaM2 = getHexagonAreaAvg(r, UNITS.m2)
                                const diaPx = (2 * edgeM) / mppx
                                const isShown = r === showRes
                                return (
                                    <tr key={r} style={{ color: isShown ? fg : dim }}>
                                        <td style={{ paddingRight: 6 }}>{isShown ? <b>r{r}</b> : `r${r}`}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{fmtMeters(edgeM)}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{fmtArea(areaM2)}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{diaPx.toFixed(1)}</td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div style={{ color: dim, fontSize: "0.85em", marginTop: 2 }}>
                        ⌀ = vertex-to-vertex; render uses radius = edge.
                    </div>
                </>
            )}
        </div>
    )
}
