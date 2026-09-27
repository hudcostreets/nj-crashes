/** A county's / muni's "most dangerous roads" (`road-ranks.parquet`): its top roads by crashes,
 *  fatal crashes, killed, or crashes per mile, counting only crashes (and miles) *within* the area. */
import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "@/src/contexts/ThemeContext"
import { Radios } from "@/src/njdot/Radios"
import { SeverityColorsDark, SeverityColorsLight } from "@/src/njdot/data"
import { fetchRoadRanks, type RoadRank } from "./roadsData"
import { rankedBy, type RankMetric } from "./roadRanks"

const METRICS: { metric: RankMetric; label: string; value: (r: RoadRank) => number | null }[] = [
    { metric: "crashes", label: "Crashes", value: r => r.n_crashes },
    { metric: "fatal", label: "Fatal crashes", value: r => r.n_fatal },
    { metric: "killed", label: "Killed", value: r => r.n_killed },
    { metric: "per_mi", label: "Crashes per mile", value: r => r.per_mi },
]

const TOP = 15

export function RoadRanksSection({ cc, mc, areaName }: { cc: number; mc: number | null; areaName: string }) {
    const { actualTheme: theme } = useTheme()
    const [metric, setMetric] = useState<RankMetric>("crashes")
    const [expanded, setExpanded] = useState(false)
    const ranks = useQuery({
        queryKey: ["road-ranks", cc, mc ?? 0],
        queryFn: () => fetchRoadRanks(cc, mc ?? 0),
    })
    const m = METRICS.find(x => x.metric === metric)!
    const rows = useMemo(() => rankedBy(ranks.data ?? [], metric), [ranks.data, metric])
    const shown = expanded ? rows : rows.slice(0, TOP)
    const max = Math.max(1e-9, ...shown.map(r => m.value(r) ?? 0))
    const dim = theme === "dark" ? "#999" : "#666"
    const barColor = metric === "crashes" || metric === "per_mi"
        ? (theme === "dark" ? SeverityColorsDark : SeverityColorsLight).i
        : (theme === "dark" ? SeverityColorsDark : SeverityColorsLight).f
    const fmt = (v: number | null) => (v === null ? "—" : metric === "per_mi" ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US"))
    const cell = { padding: "2px 6px" }

    return (
        <div>
            <Radios
                label="Rank by"
                name="road-rank-metric"
                options={METRICS.map(({ metric, label }) => ({ label, data: metric }))}
                choice={metric}
                cb={m => { setMetric(m); setExpanded(false) }}
            />
            {metric === "per_mi" && (
                <p style={{ color: dim, fontSize: "0.85em", margin: "4px 0" }}>
                    All years' crashes per mile of the road in {areaName}; roads with at least 0.25 mi and 10 crashes there.
                </p>
            )}
            {ranks.isError && <p>Error: {String(ranks.error)}</p>}
            {!ranks.data && !ranks.isError && <p style={{ color: dim }}>Loading…</p>}
            {ranks.data && !rows.length && <p style={{ color: dim }}>No ranked roads.</p>}
            {rows.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em", marginTop: 6 }}>
                    <thead>
                        <tr style={{ textAlign: "left" }}>
                            <th style={{ ...cell, textAlign: "right" }}>#</th>
                            <th style={cell}>Road</th>
                            <th style={cell}>Route</th>
                            <th style={{ ...cell, textAlign: "right" }}>{m.label} in {areaName}</th>
                            <th style={{ ...cell, width: "25%" }} />
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map(r => {
                            const v = m.value(r)
                            return (
                                <tr key={r.entity} style={{ borderTop: `1px solid ${theme === "dark" ? "#333" : "#eee"}` }}>
                                    <td style={{ ...cell, textAlign: "right", color: dim }}>{r[`rank_${metric}`]}</td>
                                    <td style={cell}><Link to={`/road/${r.slug}`}>{r.name}</Link></td>
                                    <td style={{ ...cell, color: dim }}>{r.route ?? ""}</td>
                                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</td>
                                    <td style={cell}>
                                        <div style={{ height: 10, width: `${((v ?? 0) / max) * 100}%`, background: barColor, borderRadius: 2 }} />
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            )}
            {rows.length > TOP && (
                <button
                    onClick={() => setExpanded(e => !e)}
                    style={{ marginTop: 6, padding: "2px 8px", fontSize: "0.85em", background: "transparent", color: "inherit", border: `1px solid ${dim}`, borderRadius: 3, cursor: "pointer" }}
                >
                    {expanded ? `Show top ${TOP}` : `Show all ${rows.length}`}
                </button>
            )}
        </div>
    )
}
