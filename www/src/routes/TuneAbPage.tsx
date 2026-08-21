/** `/tune/ab` — gamified A/B eval for picker-tuning changes (dev).
 *
 *  Motivation (Ryan, 2026-08-21): a tuning change eyeballed at one view
 *  can silently skew others — evaluate candidate configs across a
 *  representative *deck* of views (statewide / county / muni × zooms)
 *  before shipping. For each view where config A (shipped) and config B
 *  (candidate) pick different S2 levels, both render side-by-side with
 *  the A/B assignment randomized; vote with clicks or keys (1 = left,
 *  2 = tie, 3 = right). Views where both configs agree are auto-scored
 *  "same". The tally reveals per-view picks + winners only at the end,
 *  so votes stay blind.
 *
 *  Level selection mirrors the prod picker incl. the scoped bins-budget:
 *  `areaPx = min(vpArea, scopeArea/mppx²)` (see `CrashMapSection.
 *  hexPxTarget`) — scoped views use a hardcoded approximate admin-area
 *  (km²) rather than fetching outlines; close enough for level choice.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { metersPerPixel } from "@/src/map/CrashMap"
import { S2_PICK_MULT, S2_TARGET_FACTOR } from "@/src/map/s2"
import { BINS_BUDGET, autoHexPxTarget } from "@/src/map/picker"
import { MiniMap, pickS2WithOverrides } from "./TunePage"

type EvalView = {
    name: string
    lat: number
    lon: number
    zoom: number
    /** Approximate admin-polygon area (km²) for scoped views; null =
     *  statewide (viewport-budgeted). */
    scopeKm2: number | null
    /** Picker viewport: homepage embed clamp vs full-screen-ish. */
    vp: "embed" | "full"
}

/** Representative sweep: wide/mid statewide, large + small counties at
 *  county-fits-viewport zooms, big + small munis, street level. */
const DECK: EvalView[] = [
    { name: "statewide wide (embed)", lat: 40.07, lon: -74.55, zoom: 7.5, scopeKm2: null, vp: "embed" },
    { name: "statewide mid", lat: 40.5, lon: -74.4, zoom: 9.0, scopeKm2: null, vp: "full" },
    { name: "Hudson county fit", lat: 40.73, lon: -74.09, zoom: 10.8, scopeKm2: 120, vp: "full" },
    { name: "Hudson mid", lat: 40.73, lon: -74.07, zoom: 12.5, scopeKm2: 120, vp: "full" },
    { name: "Cape May county fit", lat: 39.1, lon: -74.82, zoom: 10.0, scopeKm2: 620, vp: "full" },
    { name: "Jersey City muni", lat: 40.72, lon: -74.06, zoom: 13.0, scopeKm2: 38, vp: "full" },
    { name: "Hoboken muni", lat: 40.745, lon: -74.03, zoom: 13.5, scopeKm2: 3.3, vp: "full" },
    { name: "JC street", lat: 40.7441, lon: -74.0585, zoom: 16.5, scopeKm2: 120, vp: "full" },
]

type TuneConfig = { targetFactor: number; pickMult: Record<number, number> }

const VP_AREAS: Record<EvalView["vp"], number> = {
    embed: 1280 * 480,
    full: 1470 * 900,
}

/** The prod pick for a view under a config — same math as
 *  `CrashMapSection.hexPxTarget` + `pickS2LevelForPixels`, parameterized
 *  by the config instead of module constants. */
function pickLevel(view: EvalView, cfg: TuneConfig): number {
    const vpArea = VP_AREAS[view.vp]
    const mppx = metersPerPixel(view.zoom, view.lat)
    let areaPx = vpArea
    if (view.scopeKm2 != null) {
        areaPx = Math.min(vpArea, (view.scopeKm2 * 1e6) / (mppx * mppx))
    }
    const target = autoHexPxTarget(areaPx, BINS_BUDGET) * cfg.targetFactor
    return pickS2WithOverrides(target, view.zoom, view.lat, cfg.pickMult)
}

type Vote = "A" | "B" | "tie" | "same"
type Result = { view: EvalView; aLevel: number; bLevel: number; leftIsA: boolean; vote: Vote | null }

const SHIPPED: TuneConfig = { targetFactor: S2_TARGET_FACTOR, pickMult: { ...S2_PICK_MULT } }

export default function TuneAbPage() {
    const [phase, setPhase] = useState<"setup" | "vote" | "done">("setup")
    const [cfgBText, setCfgBText] = useState<string>(() => JSON.stringify(SHIPPED, null, 2))
    const [cfgBError, setCfgBError] = useState<string | null>(null)
    const [results, setResults] = useState<Result[]>([])
    const [idx, setIdx] = useState(0)

    const start = useCallback(() => {
        let cfgB: TuneConfig
        try {
            const parsed = JSON.parse(cfgBText)
            if (typeof parsed.targetFactor !== "number") throw new Error("targetFactor must be a number")
            cfgB = { targetFactor: parsed.targetFactor, pickMult: parsed.pickMult ?? {} }
        } catch (e) {
            setCfgBError(String(e))
            return
        }
        setCfgBError(null)
        const rs: Result[] = DECK.map(view => {
            const aLevel = pickLevel(view, SHIPPED)
            const bLevel = pickLevel(view, cfgB)
            return {
                view, aLevel, bLevel,
                leftIsA: Math.random() < 0.5,
                vote: aLevel === bLevel ? "same" as const : null,
            }
        })
        setResults(rs)
        const first = rs.findIndex(r => r.vote === null)
        if (first < 0) { setPhase("done"); return }
        setIdx(first)
        setPhase("vote")
    }, [cfgBText])

    const vote = useCallback((which: "left" | "tie" | "right") => {
        setResults(prev => {
            const next = [...prev]
            const r = next[idx]
            next[idx] = {
                ...r,
                vote: which === "tie" ? "tie" : (which === "left") === r.leftIsA ? "A" : "B",
            }
            return next
        })
        setIdx(prev => {
            // Advance to the next unvoted pair (using the pre-update
            // results is fine: only `idx` was just voted).
            for (let i = prev + 1; i < results.length; i++) {
                if (results[i].vote === null) return i
            }
            setPhase("done")
            return prev
        })
    }, [idx, results])

    useEffect(() => {
        if (phase !== "vote") return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "1") vote("left")
            else if (e.key === "2") vote("tie")
            else if (e.key === "3") vote("right")
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [phase, vote])

    const summary = useMemo(() => {
        if (phase !== "done") return null
        const tally = { A: 0, B: 0, tie: 0, same: 0 }
        for (const r of results) if (r.vote) tally[r.vote]++
        return tally
    }, [phase, results])

    const page = (body: React.ReactNode) => (
        <div style={{ padding: 12, fontFamily: "sans-serif", color: "#eee", background: "#111", minHeight: "100vh" }}>
            <h1 style={{ fontSize: 18, marginBottom: 12, fontWeight: 500 }}>
                Picker A/B eval
                <a href="/tune" style={{ marginLeft: 12, fontSize: 13, color: "#6db3f2" }}>← /tune</a>
            </h1>
            {body}
        </div>
    )

    if (phase === "setup") {
        return page(
            <div style={{ maxWidth: 560 }}>
                <p style={{ fontSize: 13, color: "#aaa", marginBottom: 8 }}>
                    Config A = shipped <code>tuning.json</code>. Edit config B below, then
                    vote blind on each view where their level picks differ
                    (keys: <b>1</b> left · <b>2</b> tie · <b>3</b> right).
                </p>
                <textarea
                    value={cfgBText}
                    onChange={e => setCfgBText(e.target.value)}
                    rows={10}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: 13, background: "#1a1a1a", color: "#eee", border: "1px solid #444", borderRadius: 4, padding: 8 }}
                />
                {cfgBError && <div style={{ color: "#e77", fontSize: 13, marginTop: 4 }}>{cfgBError}</div>}
                <button
                    onClick={start}
                    style={{ marginTop: 8, padding: "6px 16px", background: "#2a4", color: "#eee", border: "1px solid #555", borderRadius: 3, cursor: "pointer" }}
                >Start ({DECK.length} views)</button>
            </div>
        )
    }

    if (phase === "vote") {
        const r = results[idx]
        const leftLevel = r.leftIsA ? r.aLevel : r.bLevel
        const rightLevel = r.leftIsA ? r.bLevel : r.aLevel
        const votedCount = results.filter(x => x.vote !== null && x.vote !== "same").length
        const pairCount = results.filter(x => x.vote !== "same").length
        return page(
            <div>
                <div style={{ marginBottom: 8, fontSize: 13, color: "#aaa" }}>
                    <b style={{ color: "#eee" }}>{r.view.name}</b> · z={r.view.zoom}
                    {" · pair "}{votedCount + 1}/{pairCount}
                    {" · "}<span style={{ color: "#777" }}>levels hidden until done</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 1400 }}>
                    <MiniMap lat={r.view.lat} lon={r.view.lon} zoom={r.view.zoom} level={leftLevel} renderMode="curve" range={null} dfStart={1} dfEnd={0.5} onLatLonChange={() => {}} showLabel={false} />
                    <MiniMap lat={r.view.lat} lon={r.view.lon} zoom={r.view.zoom} level={rightLevel} renderMode="curve" range={null} dfStart={1} dfEnd={0.5} onLatLonChange={() => {}} showLabel={false} />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button onClick={() => vote("left")} style={btn()}>1 ◀ left better</button>
                    <button onClick={() => vote("tie")} style={btn()}>2 · tie</button>
                    <button onClick={() => vote("right")} style={btn()}>right better ▶ 3</button>
                </div>
            </div>
        )
    }

    // done
    return page(
        <div style={{ maxWidth: 640, fontFamily: "monospace", fontSize: 13 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
                <thead>
                    <tr style={{ color: "#888", textAlign: "left" }}>
                        <th style={{ padding: "2px 8px 2px 0" }}>view</th>
                        <th style={{ padding: "2px 8px" }}>A</th>
                        <th style={{ padding: "2px 8px" }}>B</th>
                        <th style={{ padding: "2px 8px" }}>winner</th>
                    </tr>
                </thead>
                <tbody>
                    {results.map((r, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #333" }}>
                            <td style={{ padding: "2px 8px 2px 0" }}>{r.view.name}</td>
                            <td style={{ padding: "2px 8px" }}>l{r.aLevel}</td>
                            <td style={{ padding: "2px 8px" }}>l{r.bLevel}</td>
                            <td style={{ padding: "2px 8px", color: r.vote === "A" ? "#6db3f2" : r.vote === "B" ? "#7d7" : "#888" }}>
                                {r.vote === "same" ? "= (same pick)" : r.vote}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {summary && (
                <div style={{ marginBottom: 12 }}>
                    A (shipped): <b>{summary.A}</b> · B (candidate): <b>{summary.B}</b> · ties: {summary.tie} · same pick: {summary.same}
                </div>
            )}
            <button
                onClick={() => navigator.clipboard?.writeText(JSON.stringify(results.map(r => ({ view: r.view.name, a: r.aLevel, b: r.bLevel, vote: r.vote })), null, 2))}
                style={btn()}
            >copy results JSON</button>
            <button onClick={() => setPhase("setup")} style={{ ...btn(), marginLeft: 8 }}>again</button>
        </div>
    )
}

function btn(): React.CSSProperties {
    return { padding: "6px 14px", background: "#222", color: "#eee", border: "1px solid #555", borderRadius: 3, cursor: "pointer", fontSize: 13 }
}
