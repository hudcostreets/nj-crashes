import { useMemo } from "react"
import { Link } from "react-router-dom"
import { entityCrashesSql, type RoadCrash, type RoadEntity } from "./roadsData"

/** Rows rendered in the panel; the CSV export always has all of them. */
const TABLE_ROWS = 300
const CSV_COLS: (keyof RoadCrash)[] = [
    "sri", "mp", "dt", "year", "cc", "mc", "case", "severity", "tk", "ti", "pk", "pi", "tv",
    "road", "cross_street", "route", "lat", "lon", "id",
]
const SEVERITY: Record<string, string> = { f: "Fatal", i: "Injury", p: "Property" }

function csvCell(v: unknown): string {
    if (v === null || v === undefined) return ""
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(slug: string, rows: RoadCrash[]) {
    const lines = [CSV_COLS.join(",")]
    for (const r of rows) {
        lines.push(CSV_COLS.map(c => csvCell(c === "dt" ? new Date(r.dt).toISOString() : r[c])).join(","))
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `road-${slug}.csv`
    a.click()
    URL.revokeObjectURL(url)
}

export type RoadPanelProps = {
    entity: number
    info: RoadEntity | null
    crashes: RoadCrash[] | null
    loading: boolean
    onClose: () => void
    onZoomTo: (bbox: [number, number, number, number]) => void
    theme: "light" | "dark"
}

/** Selected-road summary + crash table (specs/road-name-normalization-and-search.md Layer 4b). */
export function RoadPanel({ entity, info, crashes, loading, onClose, onZoomTo, theme }: RoadPanelProps) {
    const bg = theme === "dark" ? "rgba(30,30,30,0.95)" : "rgba(255,255,255,0.95)"
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const rows = useMemo(() => crashes?.slice(0, TABLE_ROWS) ?? [], [crashes])
    const sqlHref = `/sql?q=${encodeURIComponent(entityCrashesSql(entity) + ";")}`
    const sris = info?.sris.split(",") ?? []
    const multiSri = sris.length > 1
    const slug = (info?.name ?? `road-${entity}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    const btn = { padding: "2px 8px", fontSize: "0.8em", background: "transparent", color: fg, border: `1px solid ${dim}`, borderRadius: 3, cursor: "pointer" }
    return (
        <div style={{
            position: "absolute", left: 8, bottom: 40, zIndex: 3, width: 460, maxWidth: "calc(100% - 16px)",
            maxHeight: "45%", display: "flex", flexDirection: "column",
            background: bg, color: fg, borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.4)", fontSize: 13,
        }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${dim}` }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <strong style={{ flex: 1 }}>
                        {info?.name ?? `Road ${entity}`}
                        {info?.route && <span style={{ fontWeight: "normal", color: dim }}> · on {info.route}</span>}
                    </strong>
                    <button onClick={onClose} style={{ ...btn, border: "none" }} aria-label="Clear road selection">✕</button>
                </div>
                {info?.aliases && (
                    <div style={{ color: dim, fontSize: "0.85em" }}>Also reported as: {info.aliases}</div>
                )}
                <div style={{ color: dim, fontSize: "0.8em" }}>
                    SRI{multiSri ? "s" : ""} {sris.join(", ")}
                </div>
                {info && (
                    <div style={{ marginTop: 4 }}>
                        {info.n_crashes.toLocaleString()} crashes · {info.n_fatal.toLocaleString()} fatal
                        ({info.n_killed.toLocaleString()} killed) · {info.n_injury.toLocaleString()} injury
                    </div>
                )}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    {info && <button style={btn} onClick={() => onZoomTo([info.lon_min, info.lat_min, info.lon_max, info.lat_max])}>Zoom to road</button>}
                    <button style={btn} disabled={!crashes?.length} onClick={() => crashes && downloadCsv(slug, crashes)}>Export CSV</button>
                    <a style={{ ...btn, textDecoration: "none" }} href={sqlHref} target="_blank" rel="noreferrer">Open in SQL ↗</a>
                </div>
            </div>
            <div style={{ overflow: "auto" }}>
                {loading && !crashes && <div style={{ padding: 10, color: dim }}>Loading…</div>}
                {crashes && (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                        <thead>
                            <tr style={{ position: "sticky", top: 0, background: bg, textAlign: "left" }}>
                                {multiSri && <th style={{ padding: "3px 6px" }}>SRI</th>}
                                <th style={{ padding: "3px 6px" }}>MP</th>
                                <th>Date</th>
                                <th>Severity</th>
                                <th>K/I</th>
                                <th>Cross street</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r, i) => (
                                <tr key={`${r.id ?? r.case}-${i}`} style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#eee"}` }}>
                                    {multiSri && <td style={{ padding: "2px 6px", color: dim }}>{r.sri.replace(/_+$/, "")}</td>}
                                    <td style={{ padding: "2px 6px" }}>{r.mp?.toFixed(2) ?? "—"}</td>
                                    <td>
                                        <Link to={`/crash/${r.year}/${r.cc}/${r.mc}/${encodeURIComponent(r.case)}`} style={{ color: fg }}>
                                            {new Date(r.dt).toISOString().slice(0, 10)}
                                        </Link>
                                    </td>
                                    <td>{SEVERITY[r.severity] ?? r.severity}</td>
                                    <td>{r.tk ?? 0}/{r.ti ?? 0}</td>
                                    <td>{r.cross_street ?? ""}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {crashes && crashes.length > TABLE_ROWS && (
                    <div style={{ padding: "4px 10px", color: dim, fontSize: "0.8em" }}>
                        Showing {TABLE_ROWS} of {crashes.length.toLocaleString()} (by SRI, MP) — export for all.
                    </div>
                )}
            </div>
        </div>
    )
}

/** Small label for the road (or county) under the cursor. */
export function RoadHoverChip({ name, alias, action = "click to select", theme }: { name: string; alias?: string | null; action?: string; theme: "light" | "dark" }) {
    return (
        <div style={{
            position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)", zIndex: 3,
            padding: "3px 10px", borderRadius: 12, fontSize: 12, pointerEvents: "none",
            background: theme === "dark" ? "rgba(30,30,30,0.9)" : "rgba(255,255,255,0.9)",
            color: theme === "dark" ? "#e0e0e0" : "#333",
        }}>
            {name}{alias ? ` · ${alias}` : ""} — {action}
        </div>
    )
}
