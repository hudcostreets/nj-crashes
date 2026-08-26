/** Picker / cell debug panel for the crash map.
 *
 *  Renders inline in the controls drawer (no fixed positioning). Shows the
 *  active picker plan, S2 level metrics, zoom + meters/pixel, and
 *  per-level edge / area / on-screen pixel size — exactly the
 *  observables you need to diagnose a "chunky" zoom transition without
 *  toggling devtools.
 */
import { S2_EDGE_METERS, S2_MIN_LEVEL, S2_MAX_LEVEL } from "./s2"
import type { FetchPlan } from "./v2"
import type { ViewState } from "./CrashMap"

export type Props = {
    /** Live viewport state — drives zoom + lat for meters-per-pixel calc. */
    viewState: ViewState
    /** Picker output (kind, res, shards, reason). May be null while the
     *  manifest is loading. */
    plan: FetchPlan | null
    /** Render-side level choice (`pickS2LevelForPixels`). Optional. */
    renderRes?: number
    /** Effective resolution actually rendered on screen. Optional. */
    effectiveRes?: number
    /** Hex pixel target driving render-side resolution choice. */
    cellPxTarget?: number
    /** Number of rows in the active dataset (Crash[] or StackedCell[]). */
    rowCount?: number
    /** Fetch state — "loading" before first response, "refetching" when a
     *  newer fetch is in flight while older data is still on screen,
     *  "idle" otherwise. */
    fetchState?: "idle" | "loading" | "refetching"
    /** Hovered level from the cells table. Caller renders an outline-only
     *  cell grid at this level on the map for visual reference. */
    onHoverRes?: (res: number | null) => void
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
    if (plan.shards === null) return `l${plan.res} single-file`
    return `l${plan.res} × ${plan.shards.length}`
}

export function DebugOverlay({ viewState, plan, renderRes, effectiveRes, cellPxTarget, rowCount, fetchState, onHoverRes, theme }: Props) {
    const { latitude, longitude, zoom, pitch, bearing } = viewState
    const mppx = metersPerPixel(zoom, latitude)
    const dark = theme === "dark"
    const fg = dark ? "#e0e0e0" : "#222"
    const dim = dark ? "#888" : "#666"
    const accent = dark ? "#6db3f2" : "#0066cc"

    const planRes = plan && plan.kind === "cell" ? plan.res : undefined
    const showRes = effectiveRes ?? renderRes ?? planRes

    // Show the union of plan / render / effective res, plus their
    // immediate neighbors so the user can sanity-check what the next
    // resolution boundary would look like.
    const baseRess = Array.from(new Set(
        [planRes, renderRes, effectiveRes].filter((r): r is number => typeof r === "number")
    ))
    const ress: number[] = Array.from(new Set(
        baseRess.flatMap(r => [r - 1, r, r + 1]).filter(r => r >= S2_MIN_LEVEL && r <= S2_MAX_LEVEL)
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

            {(rowCount !== undefined || cellPxTarget !== undefined) && (
                <>
                    <div style={{ marginTop: 4, color: dim }}>render</div>
                    {rowCount !== undefined && (
                        <div>
                            {plan?.kind === "cell" ? "cells" : "rows"}:{" "}
                            <b style={{ color: fg }}>{fmtRowCount(rowCount)}</b>
                        </div>
                    )}
                    {cellPxTarget !== undefined && <div>cellPxTarget: <b style={{ color: fg }}>{cellPxTarget}</b> px</div>}
                </>
            )}

            {ress.length > 0 && (
                <>
                    <div style={{ marginTop: 4, color: dim }}>s2 cells</div>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                            <tr style={{ color: dim }}>
                                <th style={{ textAlign: "left", fontWeight: 400, paddingRight: 6 }}>res</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }}>edge</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }}>area</th>
                                <th style={{ textAlign: "right", fontWeight: 400, paddingRight: 6 }} title="cell width on screen (avg edge px)">⌀ px</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ress.map(r => {
                                const edgeM = S2_EDGE_METERS[r]
                                const areaM2 = edgeM * edgeM
                                const diaPx = edgeM / mppx
                                const isShown = r === showRes
                                return (
                                    <tr
                                        key={r}
                                        style={{ color: isShown ? fg : dim, cursor: onHoverRes ? "crosshair" : undefined }}
                                        onMouseEnter={onHoverRes ? () => onHoverRes(r) : undefined}
                                        onMouseLeave={onHoverRes ? () => onHoverRes(null) : undefined}
                                        title={onHoverRes ? `Show l${r} cell grid on map` : undefined}
                                    >
                                        <td style={{ paddingRight: 6 }}>{isShown ? <b>l{r}</b> : `l${r}`}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{fmtMeters(edgeM)}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{fmtArea(areaM2)}</td>
                                        <td style={{ textAlign: "right", paddingRight: 6 }}>{diaPx.toFixed(1)}</td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div style={{ color: dim, fontSize: "0.85em", marginTop: 2 }}>
                        ⌀ = avg cell edge; render radius ≤ inscribed (edge/2).
                    </div>
                </>
            )}
        </div>
    )
}
