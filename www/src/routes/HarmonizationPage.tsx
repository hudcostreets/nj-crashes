/** Harmonization page — visualizes the 3-way fatal-crash agreement
 *  between NJSP (SP), NJDOT per-table archive (DOTr), and NJDOT AASHTO
 *  Crash.csv (DOTa). Backed by `three_way_fatals.parquet`.
 */
import { useMemo } from "react"
import { Link } from "react-router-dom"
import type { Layout, PlotData } from "plotly.js"
import { Head } from "@/src/lib/head"
import PlotWrapper from "@/src/lib/plot-wrapper"
import { useParquet } from "@/src/lib/useParquet"
import { usePlotColors } from "@/src/hooks/usePlotColors"

type ThreeWayRow = {
    src: string  // S, R, A, SR, SA, RA, SRA
    in_sp: boolean
    in_r: boolean
    in_a: boolean
    year: number
    cc: number | null
    mc: number | null
    tk_sp: number | null
    tk_r: number | null
    tk_a: number | null
    tk_a_broad: number | null
}

// Source-set categories in stacking order (bottom → top).
const SRC_ORDER = ["SRA", "SR", "SA", "RA", "S", "R", "A"] as const
type Src = typeof SRC_ORDER[number]

const SRC_LABEL: Record<Src, string> = {
    SRA: "All 3 (SP+DOTr+DOTa)",
    SR:  "SP + DOTr",
    SA:  "SP + DOTa",
    RA:  "DOTr + DOTa (no SP)",
    S:   "SP only",
    R:   "DOTr only",
    A:   "DOTa only",
}

// Color palette: agreement = green, partial = amber, single-source = red
const SRC_COLOR: Record<Src, string> = {
    SRA: "#3a8c3a",  // green — all 3 agree
    SR:  "#7ab87a",
    SA:  "#9bd09b",
    RA:  "#c3e0c3",
    S:   "#d9534f",  // SP-only — fatal not yet in either DOT
    R:   "#f0ad4e",  // DOTr-only — broad-fatal medical-event etc.
    A:   "#5bc0de",  // DOTa-only
}

const PARQUET_URL = "/data/harmonization/three_way_fatals.parquet"

export default function HarmonizationPage() {
    const { data, loading, error } = useParquet<ThreeWayRow>(PARQUET_URL)
    const plotColors = usePlotColors()

    // Pivot: year × src → count
    const { years, traces } = useMemo(() => {
        if (!data) return { years: [], traces: [] as Partial<PlotData>[] }
        const counts = new Map<number, Map<Src, number>>()
        for (const r of data) {
            const y = Number(r.year)
            if (!Number.isFinite(y)) continue
            let inner = counts.get(y)
            if (!inner) { inner = new Map(); counts.set(y, inner) }
            const s = r.src as Src
            inner.set(s, (inner.get(s) ?? 0) + 1)
        }
        const years = [...counts.keys()].sort((a, b) => a - b)
        const traces: Partial<PlotData>[] = SRC_ORDER.map(src => {
            const ys = years.map(y => counts.get(y)?.get(src) ?? 0)
            return {
                x: years,
                y: ys,
                type: "bar",
                name: SRC_LABEL[src],
                marker: { color: SRC_COLOR[src] },
                hovertemplate: `%{y:,}<extra>${SRC_LABEL[src]}</extra>`,
            }
        })
        return { years, traces }
    }, [data])

    const layout: Partial<Layout> = useMemo(() => ({
        barmode: "stack",
        height: 480,
        margin: { l: 50, r: 20, t: 30, b: 60 },
        paper_bgcolor: plotColors.paperBg,
        plot_bgcolor: plotColors.plotBg,
        font: { color: plotColors.textColor },
        hovermode: "x unified",
        hoverlabel: {
            bgcolor: "#1a1a2e",
            bordercolor: plotColors.gridColor,
            font: { color: "#ffffff" },
        },
        xaxis: {
            tickmode: "array",
            tickvals: years,
            ticktext: years.map(y => `'${String(y).slice(2)}`),
            tickfont: { color: plotColors.textColor },
            gridcolor: plotColors.gridColor,
        },
        yaxis: {
            title: { text: "fatal crashes" },
            tickfont: { color: plotColors.textColor },
            gridcolor: plotColors.gridColor,
        },
        legend: {
            orientation: "h",
            y: -0.18,
            x: 0.5,
            xanchor: "center",
            font: { color: plotColors.textColor, size: 11 },
            traceorder: "reversed",
        },
        showlegend: true,
    }), [years, plotColors])

    return (
        <div style={{
            maxWidth: 980, margin: "0 auto", padding: "1em 1.5em 4em",
            fontFamily: "system-ui, -apple-system, sans-serif",
        }}>
            <Head
                title="Fatal-Crash Harmonization — NJ Crashes"
                description="Three-way reconciliation of NJ fatal-crash records from NJSP, NJDOT per-table, and NJDOT AASHTO." />

            <h1 style={{ fontSize: "1.5em", margin: "0 0 0.4em" }}>Fatal-Crash Harmonization</h1>
            <p style={{ fontSize: "0.95em", lineHeight: 1.55, margin: "0 0 0.8em" }}>
                NJ publishes fatal-crash counts via three pipelines that don't always agree:
            </p>
            <ul style={{ fontSize: "0.92em", lineHeight: 1.5, margin: "0 0 1em 1em" }}>
                <li><strong>SP</strong> — <Link to="/">NJSP fatal-crash feed</Link>, daily-updated, 2008+ live (with PDF backfill to 2001).</li>
                <li><strong>DOTr</strong> — NJDOT <Link to="/raw/njdot/data">per-table archive</Link>, fixed-width <code>.txt</code> in per-county zips, 2001–2023.</li>
                <li><strong>DOTa</strong> — NJDOT <Link to="/raw/njdot/data/2024">AASHTO Crash.csv</Link> (vendor: Numetric), denormalized JSON-in-CSV, 2023+.</li>
            </ul>
            <p style={{ fontSize: "0.92em", lineHeight: 1.55, margin: "0 0 1em" }}>
                Each fatal crash is matched across the three sources via <a href="https://github.com/hudcostreets/njsp-crashes/blob/main/njsp/three_way_match.py" target="_blank" rel="noreferrer">a multi-pass matcher</a> (case-number join for DOTr↔DOTa; date+location fuzzy match for SP↔DOT). Each bar below is one year's fatal crashes; segments show which sources contain each crash.
            </p>

            {loading && <p style={{ opacity: 0.7 }}>Loading…</p>}
            {error && <p style={{ color: "salmon" }}>Error: {error}</p>}
            {data && (
                <PlotWrapper data={traces as PlotData[]} layout={layout} />
            )}

            <h2 style={{ fontSize: "1.15em", margin: "2em 0 0.4em" }}>Stories the data tells</h2>

            <h3 style={{ fontSize: "1em", margin: "1em 0 0.3em" }}>1. Two fatal definitions, ~10%/yr apart</h3>
            <p style={{ fontSize: "0.92em", lineHeight: 1.55, margin: "0 0 0.6em" }}>
                AASHTO carries both a <strong>strict</strong> flag (<code>Fatal Crash Indicator='Y'</code>, MMUCC/federal-reportable, NJSP-aligned) and a <strong>broad</strong> count (<code>Total Killed&nbsp;&gt;&nbsp;0</code>, includes ~10%/yr extra deaths where the crash didn't <em>cause</em> the fatality — typically drivers having medical emergencies and striking objects with no traffic injuries). The site uses strict everywhere.
            </p>
            <p style={{ fontSize: "0.92em", lineHeight: 1.55, margin: "0 0 0.6em" }}>
                The <strong>orange "DOTr only"</strong> band before 2023 is mostly this: per-table <code>severity='f'</code> uses the broad definition, so it includes ~10%/yr fatals NJSP doesn't count.
            </p>

            <h3 style={{ fontSize: "1em", margin: "1em 0 0.3em" }}>2. 2023's per-table archive was broken</h3>
            <p style={{ fontSize: "0.92em", lineHeight: 1.55, margin: "0 0 0.6em" }}>
                The 2023 per-table extracts have an impossible 0.93 deaths-per-fatal-crash ratio (649 fatal crashes / 604 deaths). The fix was to use AASHTO 2023 instead — it matches NJSP exactly (574 / 606). All three sources agree on 555 of 574 fatals; the rest are reclassification disagreements.
            </p>

            <h3 style={{ fontSize: "1em", margin: "1em 0 0.3em" }}>3. AASHTO 2025 fatal-classification lag</h3>
            <p style={{ fontSize: "0.92em", lineHeight: 1.55, margin: "0 0 0.6em" }}>
                The <strong>red "SP only"</strong> band on 2025 is 111 NJSP fatals AASHTO hasn't ingested yet. It's <em>not</em> a uniform ingestion lag — AASHTO's 2025 PDO and injury counts are at ~2024 levels. It's specifically a <strong>fatal-reclassification lag</strong> concentrated in Middlesex, Hudson, and Essex (these counties show 31-39% of 2024 fatal counts while their injury/PDO counts are ~normal). Fatal status requires death-cert / 30-day-rule confirmation; certain agencies are slower to upgrade. The homepage NJDOT plot supplements these into AASHTO so the bar reflects the true count.
            </p>
        </div>
    )
}
