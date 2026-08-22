/** `/tune/ab` — streaming preference collection for the S2 level picker (dev).
 *
 *  v2 flow (Ryan, 2026-08-21): the page generates side-by-side pairs
 *  itself — a sampled view (deck entry + zoom jitter) rendered at the
 *  shipped picker's level vs an adjacent level — and asks which looks
 *  better. No config authoring: the voter's only job is aesthetic
 *  preference (keys: 1 = left · 2 = tie · 3 = right; s = skip without
 *  recording). Each vote POSTs to the dev middleware (`/__tune/vote`),
 *  which appends a JSONL row to `www/tune/votes.jsonl` — git-tracked, so
 *  the corpus accumulates across sessions. Rows carry the full feature
 *  set the picker could condition on: viewport dims, zoom, mppx,
 *  clip-share-budgeted areaPx, scope area, ACTUAL bins fetched per side,
 *  the shipped-config snapshot, and the choice. Fitting the corpus into
 *  picker thresholds / a decision tree happens offline (Claude reads the
 *  file); contradictory votes over time are expected — they localize
 *  boundary insensitivity rather than being noise to discard.
 *
 *  Level numbers stay hidden (no anchoring on "which is shipped"); the
 *  per-side bins count IS shown, since data cost is a legitimate input
 *  to preference. Level selection mirrors the prod picker incl. the
 *  scoped bins-budget: `areaPx = min(vpArea, scopeArea/mppx²)` (see
 *  `CrashMapSection.hexPxTarget`) — scoped views use a hardcoded
 *  approximate admin-area (km²) rather than fetching outlines; close
 *  enough for level choice.
 */
import { useCallback, useEffect, useState } from "react"
import { metersPerPixel } from "@/src/map/CrashMap"
import { S2_MAX_LEVEL, S2_MIN_LEVEL, S2_PICK_MULT, S2_TARGET_FACTOR } from "@/src/map/s2"
import { BINS_BUDGET, autoHexPxTarget } from "@/src/map/picker"
import { MiniMap, pickS2WithOverrides } from "./TunePage"

type EvalView = {
    name: string
    lat: number
    lon: number
    zoom: number
    /** Uniform zoom jitter half-width applied when sampling this view,
     *  so votes cover the neighborhood rather than one exact zoom. */
    zoomJitter: number
    /** Approximate admin-polygon area (km²) for scoped views; null =
     *  statewide (viewport-budgeted). */
    scopeKm2: number | null
    /** Picker viewport: homepage embed clamp vs full-screen-ish. */
    vp: "embed" | "full"
}

/** Representative sweep: wide/mid statewide, large + small counties at
 *  county-fits-viewport zooms, big + small munis, street level. */
const DECK: EvalView[] = [
    { name: "statewide wide (embed)", lat: 40.07, lon: -74.55, zoom: 7.5, zoomJitter: 0.5, scopeKm2: null, vp: "embed" },
    { name: "statewide mid", lat: 40.5, lon: -74.4, zoom: 9.0, zoomJitter: 0.7, scopeKm2: null, vp: "full" },
    { name: "Hudson county fit", lat: 40.73, lon: -74.09, zoom: 10.8, zoomJitter: 0.4, scopeKm2: 120, vp: "full" },
    { name: "Hudson mid", lat: 40.73, lon: -74.07, zoom: 12.5, zoomJitter: 0.7, scopeKm2: 120, vp: "full" },
    { name: "Cape May county fit", lat: 39.1, lon: -74.82, zoom: 10.0, zoomJitter: 0.4, scopeKm2: 620, vp: "full" },
    { name: "Jersey City muni", lat: 40.72, lon: -74.06, zoom: 13.0, zoomJitter: 0.6, scopeKm2: 38, vp: "full" },
    { name: "Hoboken muni", lat: 40.745, lon: -74.03, zoom: 13.5, zoomJitter: 0.6, scopeKm2: 3.3, vp: "full" },
    { name: "JC street", lat: 40.7441, lon: -74.0585, zoom: 16.5, zoomJitter: 1.0, scopeKm2: 120, vp: "full" },
]

const VP_DIMS: Record<EvalView["vp"], [number, number]> = {
    embed: [1280, 480],
    full: [1470, 900],
}

const SHIPPED = { targetFactor: S2_TARGET_FACTOR, pickMult: { ...S2_PICK_MULT } }

/** The prod pick for a view+zoom, plus the intermediate features a
 *  learner would condition on — same math as `CrashMapSection.
 *  hexPxTarget` + `pickS2LevelForPixels`. */
function pickWithFeatures(view: EvalView, zoom: number) {
    const [vpw, vph] = VP_DIMS[view.vp]
    const vpArea = vpw * vph
    const mppx = metersPerPixel(zoom, view.lat)
    let areaPx = vpArea
    if (view.scopeKm2 != null) {
        areaPx = Math.min(vpArea, (view.scopeKm2 * 1e6) / (mppx * mppx))
    }
    const autoTargetPx = autoHexPxTarget(areaPx, BINS_BUDGET)
    const level = pickS2WithOverrides(autoTargetPx * SHIPPED.targetFactor, zoom, view.lat, SHIPPED.pickMult)
    return { level, mppx, areaPx, autoTargetPx }
}

type Pair = {
    view: EvalView
    zoom: number
    prod: number
    alt: number
    leftIsProd: boolean
    feats: { mppx: number; areaPx: number; autoTargetPx: number }
}

function genPair(): Pair {
    const view = DECK[Math.floor(Math.random() * DECK.length)]
    const zoom = view.zoom + (Math.random() * 2 - 1) * view.zoomJitter
    const { level: prod, ...feats } = pickWithFeatures(view, zoom)
    // Challenger: an adjacent level, direction random (flipped at the
    // pyramid's edges). Prod-vs-neighbor is exactly the label the
    // learner needs: "was the shipped pick right, or one step off?"
    const dir = Math.random() < 0.5 ? -1 : 1
    const alt = prod + dir >= S2_MIN_LEVEL && prod + dir <= S2_MAX_LEVEL ? prod + dir : prod - dir
    return { view, zoom, prod, alt, leftIsProd: Math.random() < 0.5, feats }
}

type Bins = { left: number | null; right: number | null }

export default function TuneAbPage() {
    const [pair, setPair] = useState<Pair | null>(null)
    const [bins, setBins] = useState<Bins>({ left: null, right: null })
    const [total, setTotal] = useState<number | null>(null)
    const [session, setSession] = useState(0)
    const [saveError, setSaveError] = useState<string | null>(null)

    // All-time vote count, for the header.
    useEffect(() => {
        fetch("/__tune/votes")
            .then(r => r.text())
            .then(text => setTotal(text.split("\n").filter(Boolean).length))
            .catch(() => setTotal(0))
    }, [])

    const next = useCallback(() => {
        setBins({ left: null, right: null })
        setPair(genPair())
    }, [])

    useEffect(() => { next() }, [next])

    const onLeftCount = useCallback((n: number) => setBins(b => ({ ...b, left: n })), [])
    const onRightCount = useCallback((n: number) => setBins(b => ({ ...b, right: n })), [])

    const loaded = bins.left !== null && bins.right !== null

    const vote = useCallback(async (which: "left" | "tie" | "right") => {
        if (!pair || !loaded) return
        const leftLevel = pair.leftIsProd ? pair.prod : pair.alt
        const rightLevel = pair.leftIsProd ? pair.alt : pair.prod
        const [vpw, vph] = VP_DIMS[pair.view.vp]
        const rec = {
            ts: new Date().toISOString(),
            view: pair.view.name,
            lat: pair.view.lat,
            lon: pair.view.lon,
            zoom: +pair.zoom.toFixed(3),
            vp: [vpw, vph],
            scopeKm2: pair.view.scopeKm2,
            mppx: +pair.feats.mppx.toFixed(3),
            areaPx: Math.round(pair.feats.areaPx),
            autoTargetPx: +pair.feats.autoTargetPx.toFixed(3),
            cfg: SHIPPED,
            prod: pair.prod,
            left: leftLevel,
            right: rightLevel,
            bins,
            choice: which,
            chosen: which === "tie" ? null : which === "left" ? leftLevel : rightLevel,
        }
        try {
            const r = await fetch("/__tune/vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(rec),
            })
            const json = await r.json()
            if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`)
            setSaveError(null)
            setTotal(t => (t ?? 0) + 1)
            setSession(s => s + 1)
            next()
        } catch (err) {
            // Leave the pair up — the vote wasn't recorded, so retrying
            // (or skipping) is the user's call.
            setSaveError(String(err))
        }
    }, [pair, bins, loaded, next])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "1") vote("left")
            else if (e.key === "2") vote("tie")
            else if (e.key === "3") vote("right")
            else if (e.key === "s") next()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [vote, next])

    const binsLabel = (n: number | null) =>
        n === null ? "loading…" : n >= 1000 ? `≈${(n / 1000).toFixed(1)}k bins` : `${n} bins`

    return (
        <div style={{ padding: 12, fontFamily: "sans-serif", color: "#eee", background: "#111", minHeight: "100vh" }}>
            <h1 style={{ fontSize: 18, marginBottom: 4, fontWeight: 500 }}>
                Picker preference stream
                <a href="/tune" style={{ marginLeft: 12, fontSize: 13, color: "#6db3f2" }}>← /tune</a>
            </h1>
            <p style={{ fontSize: 13, color: "#aaa", marginBottom: 12 }}>
                Which binning looks better? <b>1</b> left · <b>2</b> tie · <b>3</b> right · <b>s</b> skip.
                Votes append to <code>www/tune/votes.jsonl</code>
                {" · "}{total === null ? "…" : `${total} all-time`} · {session} this session
            </p>
            {saveError && (
                <div style={{ color: "#e77", fontSize: 13, marginBottom: 8 }}>
                    vote not saved: {saveError} — retry or press <b>s</b> to skip
                </div>
            )}
            {pair && (
                <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: "#aaa" }}>
                        <b style={{ color: "#eee" }}>{pair.view.name}</b> · z={pair.zoom.toFixed(2)}
                        {" · "}<span style={{ color: "#777" }}>levels hidden — vote on looks (bins count = data cost)</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 1400 }}>
                        {(["left", "right"] as const).map(side => {
                            const level = (side === "left") === pair.leftIsProd ? pair.prod : pair.alt
                            return (
                                <div key={`${side}-${pair.view.name}-${pair.zoom}-${level}`}>
                                    <MiniMap
                                        lat={pair.view.lat} lon={pair.view.lon} zoom={pair.zoom} level={level}
                                        renderMode="curve" range={null} dfStart={1} dfEnd={0.5}
                                        onLatLonChange={() => {}} showLabel={false}
                                        onCellCount={side === "left" ? onLeftCount : onRightCount}
                                    />
                                    <div style={{ fontSize: 12, color: "#888", fontFamily: "monospace", marginTop: 2 }}>
                                        {binsLabel(bins[side])}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <button onClick={() => vote("left")} disabled={!loaded} style={btn(loaded)}>1 ◀ left better</button>
                        <button onClick={() => vote("tie")} disabled={!loaded} style={btn(loaded)}>2 · tie</button>
                        <button onClick={() => vote("right")} disabled={!loaded} style={btn(loaded)}>right better ▶ 3</button>
                        <button onClick={next} style={{ ...btn(true), marginLeft: "auto" }}>s · skip</button>
                    </div>
                </div>
            )}
        </div>
    )
}

function btn(enabled: boolean): React.CSSProperties {
    return {
        padding: "6px 14px",
        background: "#222",
        color: enabled ? "#eee" : "#666",
        border: "1px solid #555",
        borderRadius: 3,
        cursor: enabled ? "pointer" : "default",
        fontSize: 13,
    }
}
