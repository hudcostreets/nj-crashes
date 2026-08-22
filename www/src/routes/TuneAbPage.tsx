/** `/tune/ab` — streaming preference collection for the S2 level picker (dev).
 *
 *  v2 flow (Ryan, 2026-08-21): the page generates side-by-side pairs
 *  itself — a sampled view (deck entry + zoom jitter) rendered at the
 *  shipped picker's level vs an adjacent level — and asks which looks
 *  better. No config authoring. Each vote POSTs to the dev middleware
 *  (`/__tune/vote`), appending a JSONL row to git-tracked
 *  `www/tune/votes.jsonl`; rows carry the features a picker learner
 *  conditions on (viewport dims, zoom, mppx, clip-share-budgeted areaPx,
 *  per-side level/bins/bytes/latency, config snapshot) plus the choice.
 *  Fitting the corpus into picker thresholds happens offline (see
 *  `specs/tune-preference-learning.md`).
 *
 *  v2.1 (same day): informed voting replaces blind — each side shows its
 *  level, px sizes, body/wire bytes, and load time (Ryan: "i'll want to
 *  take those metrics into account"). Richer verdicts for
 *  outside-the-pair sweet spots: 4 = both too coarse (want finer),
 *  5 = both too fine (want coarser), plus an optional free-text note.
 *  The current pair is URL-encoded (`?p=viewIdx:zoom:left:right`) so a
 *  case can be revisited/shared, and a history panel lists past votes
 *  with in-place editing (choice/note rewrite the row via
 *  `/__tune/vote/update`, stamping `editedTs`).
 *
 *  Keys: 1 left · 2 tie · 3 right · 4 finer · 5 coarser · s skip.
 *
 *  Level selection mirrors the prod picker incl. the scoped bins-budget:
 *  `areaPx = min(vpArea, scopeArea/mppx²)` (see `CrashMapSection.
 *  hexPxTarget`) — scoped views use a hardcoded approximate admin-area
 *  (km²) rather than fetching outlines; close enough for level choice.
 */
import { useCallback, useEffect, useState } from "react"
import { useUrlState, stringParam } from "use-prms"
import { metersPerPixel } from "@/src/map/CrashMap"
import { S2_MAX_LEVEL, S2_MIN_LEVEL, S2_PICK_MULT, S2_TARGET_FACTOR } from "@/src/map/s2"
import { BINS_BUDGET, autoHexPxTarget } from "@/src/map/picker"
import { MiniMap, fmtBytes, pickS2WithOverrides, type MiniMapStats } from "./TunePage"

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
    viewIdx: number
    view: EvalView
    zoom: number
    /** Displayed levels; one of them is `prod` (the shipped pick). */
    left: number
    right: number
    prod: number
    feats: { mppx: number; areaPx: number; autoTargetPx: number }
}

function makePair(viewIdx: number, zoom: number, left: number, right: number): Pair {
    const view = DECK[viewIdx]
    const { level: prod, ...feats } = pickWithFeatures(view, zoom)
    return { viewIdx, view, zoom, left, right, prod, feats }
}

function genPair(): Pair {
    const viewIdx = Math.floor(Math.random() * DECK.length)
    const view = DECK[viewIdx]
    const zoom = view.zoom + (Math.random() * 2 - 1) * view.zoomJitter
    const { level: prod } = pickWithFeatures(view, zoom)
    // Challenger: an adjacent level, direction random (flipped at the
    // pyramid's edges). Prod-vs-neighbor is exactly the label the
    // learner needs: "was the shipped pick right, or one step off?"
    const dir = Math.random() < 0.5 ? -1 : 1
    const alt = prod + dir >= S2_MIN_LEVEL && prod + dir <= S2_MAX_LEVEL ? prod + dir : prod - dir
    const leftIsProd = Math.random() < 0.5
    return makePair(viewIdx, zoom, leftIsProd ? prod : alt, leftIsProd ? alt : prod)
}

/** `?p=viewIdx:zoom:left:right` — enough to reconstruct the pair
 *  deterministically (prod/features recompute from view+zoom). */
function encodePair(p: Pair): string {
    return `${p.viewIdx}:${p.zoom.toFixed(3)}:${p.left}:${p.right}`
}

function decodePair(s: string | undefined): Pair | null {
    if (!s) return null
    const parts = s.split(":").map(Number)
    if (parts.length !== 4 || parts.some(isNaN)) return null
    const [viewIdx, zoom, left, right] = parts
    if (viewIdx < 0 || viewIdx >= DECK.length) return null
    return makePair(viewIdx, zoom, left, right)
}

/** left/right preference; tie; or "the sweet spot is outside this pair"
 *  directional verdicts (finer = smaller bins than both shown). */
type Choice = "left" | "right" | "tie" | "finer" | "coarser"

const CHOICES: { key: string; choice: Choice | "skip"; label: string }[] = [
    { key: "1", choice: "left", label: "1 ◀ left better" },
    { key: "2", choice: "tie", label: "2 · tie" },
    { key: "3", choice: "right", label: "right better ▶ 3" },
    { key: "4", choice: "finer", label: "4 · neither: want finer" },
    { key: "5", choice: "coarser", label: "5 · neither: want coarser" },
]

type SideRec = { level: number; bins: number | null; bodyBytes: number | null; wireBytes: number | null; ms: number | null }

/** One `votes.jsonl` row (v2 schema; v1 rows — plain-number left/right +
 *  a separate `bins` object — still exist at the head of the file and
 *  are normalized on read in `parseRow`). */
type VoteRow = {
    v: 2
    ts: string
    editedTs?: string
    view: string
    lat: number
    lon: number
    zoom: number
    vp: [number, number]
    scopeKm2: number | null
    mppx: number
    areaPx: number
    autoTargetPx: number
    cfg: typeof SHIPPED
    prod: number
    left: SideRec
    right: SideRec
    choice: Choice
    chosen: number | null
    note: string
}

function parseRow(line: string): VoteRow | null {
    try {
        const raw = JSON.parse(line)
        if (raw.v === 2) return raw as VoteRow
        // v1 → v2 normalization (level-only sides).
        const side = (which: "left" | "right"): SideRec => ({
            level: raw[which],
            bins: raw.bins?.[which] ?? null,
            bodyBytes: null,
            wireBytes: null,
            ms: null,
        })
        return { ...raw, v: 2, left: side("left"), right: side("right"), note: raw.note ?? "" }
    } catch {
        return null
    }
}

type Stats = { left: MiniMapStats | null; right: MiniMapStats | null }

export default function TuneAbPage() {
    const [pParam, setPParam] = useUrlState("p", stringParam())
    const [pair, setPair] = useState<Pair | null>(() => decodePair(pParam) ?? genPair())
    const [stats, setStats] = useState<Stats>({ left: null, right: null })
    const [rows, setRows] = useState<VoteRow[]>([])
    const [session, setSession] = useState(0)
    const [note, setNote] = useState("")
    const [saveError, setSaveError] = useState<string | null>(null)

    useEffect(() => {
        if (pair) setPParam(encodePair(pair))
    }, [pair, setPParam])

    const refreshRows = useCallback(() => {
        fetch("/__tune/votes")
            .then(r => r.text())
            .then(text => setRows(
                text.split("\n").filter(Boolean).map(parseRow).filter((r): r is VoteRow => r !== null),
            ))
            .catch(() => {})
    }, [])
    useEffect(() => { refreshRows() }, [refreshRows])

    const next = useCallback(() => {
        setStats({ left: null, right: null })
        setNote("")
        setPair(genPair())
    }, [])

    const openRow = useCallback((row: VoteRow) => {
        const viewIdx = DECK.findIndex(v => v.name === row.view)
        if (viewIdx < 0) return  // deck entry renamed/removed since the vote
        setStats({ left: null, right: null })
        setNote(row.note ?? "")
        setPair(makePair(viewIdx, row.zoom, row.left.level, row.right.level))
    }, [])

    const onLeftStats = useCallback((s: MiniMapStats) => setStats(prev => ({ ...prev, left: s })), [])
    const onRightStats = useCallback((s: MiniMapStats) => setStats(prev => ({ ...prev, right: s })), [])

    const loaded = stats.left !== null && stats.right !== null

    const vote = useCallback(async (choice: Choice) => {
        if (!pair || !loaded) return
        const [vpw, vph] = VP_DIMS[pair.view.vp]
        const side = (level: number, s: MiniMapStats | null): SideRec => ({
            level,
            bins: s?.cells ?? null,
            bodyBytes: s?.bodyBytes ?? null,
            wireBytes: s?.wireBytes ?? null,
            ms: s?.ms ?? null,
        })
        const rec: VoteRow = {
            v: 2,
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
            left: side(pair.left, stats.left),
            right: side(pair.right, stats.right),
            choice,
            chosen: choice === "left" ? pair.left : choice === "right" ? pair.right : null,
            note: note.trim(),
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
            setRows(prev => [...prev, rec])
            setSession(s => s + 1)
            next()
        } catch (err) {
            // Leave the pair up — the vote wasn't recorded, so retrying
            // (or skipping) is the user's call.
            setSaveError(String(err))
        }
    }, [pair, stats, loaded, note, next])

    const updateRow = useCallback(async (row: VoteRow, patch: Partial<VoteRow>) => {
        try {
            const r = await fetch("/__tune/vote/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ts: row.ts, ...patch }),
            })
            const json = await r.json()
            if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`)
            setSaveError(null)
            refreshRows()
        } catch (err) {
            setSaveError(String(err))
        }
    }, [refreshRows])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
            const c = CHOICES.find(c => c.key === e.key)
            if (c && c.choice !== "skip") vote(c.choice)
            else if (e.key === "s") next()
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [vote, next])

    const fmtCount = (n: number | null) =>
        n === null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

    return (
        <div style={{ padding: 12, fontFamily: "sans-serif", color: "#eee", background: "#111", minHeight: "100vh" }}>
            <h1 style={{ fontSize: 18, marginBottom: 4, fontWeight: 500 }}>
                Picker preference stream
                <a href="/tune" style={{ marginLeft: 12, fontSize: 13, color: "#6db3f2" }}>← /tune</a>
            </h1>
            <p style={{ fontSize: 13, color: "#aaa", marginBottom: 12 }}>
                Which binning looks better? <b>1</b> left · <b>2</b> tie · <b>3</b> right ·{" "}
                <b>4</b> neither (finer) · <b>5</b> neither (coarser) · <b>s</b> skip.
                Votes append to <code>www/tune/votes.jsonl</code>
                {" · "}{rows.length} all-time · {session} this session
            </p>
            {saveError && (
                <div style={{ color: "#e77", fontSize: 13, marginBottom: 8 }}>
                    not saved: {saveError} — retry or press <b>s</b> to skip
                </div>
            )}
            {pair && (
                <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: "#aaa" }}>
                        <b style={{ color: "#eee" }}>{pair.view.name}</b> · z={pair.zoom.toFixed(2)}
                        {pair.view.scopeKm2 != null && ` · scope ${pair.view.scopeKm2} km²`}
                        {" · budgeted "}{Math.round(pair.feats.areaPx / 1000)}k px²
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 1400 }}>
                        {(["left", "right"] as const).map(sideName => {
                            const level = pair[sideName]
                            return (
                                <MiniMap
                                    key={`${sideName}-${encodePair(pair)}`}
                                    lat={pair.view.lat} lon={pair.view.lon} zoom={pair.zoom} level={level}
                                    renderMode="curve" range={null} dfStart={1} dfEnd={0.5}
                                    onLatLonChange={() => {}}
                                    onStats={sideName === "left" ? onLeftStats : onRightStats}
                                />
                            )
                        })}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                        {CHOICES.map(c => (
                            <button key={c.key} onClick={() => vote(c.choice as Choice)} disabled={!loaded} style={btn(loaded)}>
                                {c.label}
                            </button>
                        ))}
                        <input
                            type="text"
                            placeholder="optional note (recorded with the vote)"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            style={{ flex: "1 1 240px", minWidth: 200, padding: "5px 8px", background: "#1a1a1a", color: "#eee", border: "1px solid #444", borderRadius: 3, fontSize: 13 }}
                        />
                        <button onClick={next} style={btn(true)}>s · skip</button>
                    </div>
                </div>
            )}
            {rows.length > 0 && (
                <div style={{ marginTop: 24 }}>
                    <div style={{ fontSize: 14, marginBottom: 6, color: "#ccc" }}>Vote history ({rows.length})</div>
                    <table style={{ borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
                        <thead>
                            <tr style={{ color: "#888", textAlign: "left" }}>
                                {["when", "view", "z", "left", "right", "choice", "note", ""].map(h => (
                                    <th key={h} style={{ padding: "2px 10px 2px 0" }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {[...rows].reverse().map(row => (
                                <tr key={row.ts} style={{ borderTop: "1px solid #2a2a2a" }}>
                                    <td style={{ padding: "3px 10px 3px 0", color: "#888" }} title={row.ts + (row.editedTs ? ` (edited ${row.editedTs})` : "")}>
                                        {row.ts.slice(5, 16).replace("T", " ")}{row.editedTs ? "*" : ""}
                                    </td>
                                    <td style={{ padding: "3px 10px 3px 0" }}>{row.view}</td>
                                    <td style={{ padding: "3px 10px 3px 0" }}>{row.zoom.toFixed(2)}</td>
                                    {(["left", "right"] as const).map(s => (
                                        <td key={s} style={{ padding: "3px 10px 3px 0", color: row.chosen === row[s].level ? "#7d7" : undefined }}>
                                            l{row[s].level} · {fmtCount(row[s].bins)}
                                            {row[s].wireBytes != null && row[s].wireBytes !== 0 ? ` · ${fmtBytes(row[s].wireBytes)}` : ""}
                                        </td>
                                    ))}
                                    <td style={{ padding: "3px 10px 3px 0" }}>
                                        <select
                                            value={row.choice}
                                            onChange={e => {
                                                const choice = e.target.value as Choice
                                                updateRow(row, {
                                                    choice,
                                                    chosen: choice === "left" ? row.left.level : choice === "right" ? row.right.level : null,
                                                })
                                            }}
                                            style={{ background: "#1a1a1a", color: "#eee", border: "1px solid #444", borderRadius: 3, fontFamily: "monospace", fontSize: 12 }}
                                        >
                                            {(["left", "right", "tie", "finer", "coarser"] as const).map(c => (
                                                <option key={c} value={c}>{c}</option>
                                            ))}
                                        </select>
                                    </td>
                                    <td style={{ padding: "3px 10px 3px 0", color: "#aaa", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.note}>
                                        {row.note}
                                    </td>
                                    <td style={{ padding: "3px 0" }}>
                                        <button onClick={() => openRow(row)} style={{ ...btn(true), padding: "2px 8px", fontSize: 12 }}>open</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
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
