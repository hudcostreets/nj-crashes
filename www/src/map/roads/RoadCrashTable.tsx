/** A road's crash table + CSV export, shared by the map's `RoadPanel` and the road page. */
import { Link } from "react-router-dom"
import type { RoadCrash } from "./roadsData"

const CSV_COLS: (keyof RoadCrash)[] = [
    "sri", "mp", "dt", "year", "cc", "mc", "case", "severity", "tk", "ti", "pk", "pi", "tv",
    "road", "cross_street", "route", "lat", "lon", "id",
]
export const SEVERITY: Record<string, string> = { f: "Fatal", i: "Injury", p: "Property" }

function csvCell(v: unknown): string {
    if (v === null || v === undefined) return ""
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function roadSlug(name: string | null | undefined, entity: number): string {
    return (name ?? `road-${entity}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export function downloadCsv(slug: string, rows: RoadCrash[]) {
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

export function crashHref(r: Pick<RoadCrash, "year" | "cc" | "mc" | "case">): string {
    return `/crash/${r.year}/${r.cc}/${r.mc}/${encodeURIComponent(r.case)}`
}

export type RoadCrashTableProps = {
    rows: RoadCrash[]
    /** Show the SRI column (roads spanning several SRIs). */
    multiSri: boolean
    theme: "light" | "dark"
    /** Sticky-header background (matches the container's). */
    headerBg: string
}

export function RoadCrashTable({ rows, multiSri, theme, headerBg }: RoadCrashTableProps) {
    const fg = theme === "dark" ? "#e0e0e0" : "#333"
    const dim = theme === "dark" ? "#999" : "#666"
    const cell = { padding: "2px 6px" }
    return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
            <thead>
                <tr style={{ position: "sticky", top: 0, background: headerBg, textAlign: "left" }}>
                    {multiSri && <th style={{ padding: "3px 6px" }}>SRI</th>}
                    <th style={{ padding: "3px 6px" }}>MP</th>
                    <th style={cell}>Date</th>
                    <th style={cell}>Severity</th>
                    <th style={cell}>K/I</th>
                    <th style={cell}>Cross street</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={`${r.id ?? r.case}-${i}`} style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#eee"}` }}>
                        {multiSri && <td style={{ ...cell, color: dim }}>{r.sri.replace(/_+$/, "")}</td>}
                        <td style={cell}>{r.mp?.toFixed(2) ?? "—"}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                            <Link to={crashHref(r)} style={{ color: fg }}>
                                {new Date(r.dt).toISOString().slice(0, 10)}
                            </Link>
                        </td>
                        <td style={cell}>{SEVERITY[r.severity] ?? r.severity}</td>
                        <td style={cell}>{r.tk ?? 0}/{r.ti ?? 0}</td>
                        <td style={cell}>{r.cross_street ?? ""}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
