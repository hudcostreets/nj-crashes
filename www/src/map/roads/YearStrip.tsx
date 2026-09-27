/** Compact per-year crash bars (stacked by severity) for `RoadPanel`; hovering a year shows its
 *  counts in the readout line. */
import { useState } from "react"
import { SEVERITY_COLOR } from "../basemap"
import type { YearStats } from "./roadStats"

const rgb = (s: "f" | "i" | "p") => `rgb(${SEVERITY_COLOR[s].join(",")})`

export function YearStrip({ stats, dim, height = 28 }: { stats: YearStats; dim: string; height?: number }) {
    const [hover, setHover] = useState<number | null>(null)
    const { years, f, i, p } = stats
    const totals = years.map((_, k) => f[k] + i[k] + p[k])
    const max = Math.max(1, ...totals)
    const n = years.length
    const k = hover
    return (
        <div style={{ marginTop: 6 }}>
            <svg
                viewBox={`0 0 ${n} ${height}`}
                preserveAspectRatio="none"
                style={{ width: "100%", height, display: "block" }}
                onMouseLeave={() => setHover(null)}
            >
                {years.map((_, j) => {
                    const h = (v: number) => (v / max) * height
                    const hp = h(p[j]), hi = h(i[j]), hf = h(f[j])
                    return (
                        <g key={j} onMouseEnter={() => setHover(j)} opacity={hover === null || hover === j ? 1 : 0.55}>
                            <rect x={j} y={0} width={1} height={height} fill="transparent" />
                            <rect x={j + 0.1} y={height - hf} width={0.8} height={hf} fill={rgb("f")} />
                            <rect x={j + 0.1} y={height - hf - hi} width={0.8} height={hi} fill={rgb("i")} />
                            <rect x={j + 0.1} y={height - hf - hi - hp} width={0.8} height={hp} fill={rgb("p")} />
                        </g>
                    )
                })}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", color: dim, fontSize: "0.75em" }}>
                <span>{years[0]}</span>
                <span>
                    {k !== null
                        ? `${years[k]}: ${totals[k].toLocaleString()} crashes · ${f[k]} fatal · ${i[k]} injury · ${stats.killed[k]} killed`
                        : "Crashes per year"}
                </span>
                <span>{years[n - 1]}</span>
            </div>
        </div>
    )
}
