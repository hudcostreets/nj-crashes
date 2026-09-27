/** A road's crash table + CSV export, shared by the map's `RoadPanel` and the road page. */
import { useState, type CSSProperties } from "react"
import { Link } from "react-router-dom"
import { useDb } from "@/src/lib/DuckDbContext"
import { fetchEntityCrashesFull, type RoadCrash, type RoadCrashView } from "./roadsData"

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

/** `slug`: the road's slug (`hudson/jersey-city/west-side-avenue` → `road-hudson_jersey-city_west-side-avenue.csv`). */
export function downloadCsv(slug: string, rows: RoadCrash[]) {
    const lines = [CSV_COLS.join(",")]
    for (const r of rows) {
        lines.push(CSV_COLS.map(c => csvCell(c === "dt" ? new Date(r.dt).toISOString() : r[c])).join(","))
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `road-${slug.replace(/\//g, "_")}.csv`
    a.click()
    URL.revokeObjectURL(url)
}

/** Exports every column of every crash on the road; the views only load the columns they show. */
export function ExportCsvButton({ entity, slug, disabled, style }: { entity: number; slug: string; disabled?: boolean; style: CSSProperties }) {
    const db = useDb()
    const [busy, setBusy] = useState(false)
    const onClick = async () => {
        if (!db) return
        setBusy(true)
        try {
            downloadCsv(slug, await fetchEntityCrashesFull(db, entity))
        } finally {
            setBusy(false)
        }
    }
    return <button style={style} disabled={disabled || busy || !db} onClick={onClick}>{busy ? "Exporting…" : "Export CSV"}</button>
}

export function crashHref(r: Pick<RoadCrash, "year" | "cc" | "mc" | "case">): string {
    return `/crash/${r.year}/${r.cc}/${r.mc}/${encodeURIComponent(r.case)}`
}

export type RoadCrashTableProps = {
    rows: RoadCrashView[]
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
