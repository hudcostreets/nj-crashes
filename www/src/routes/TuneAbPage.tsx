/** `/tune/ab` — streaming preference collection for the S2 level picker (dev).
 *
 *  v2 flow (Ryan, 2026-08-21): the page generates side-by-side pairs
 *  itself — a sampled view (deck entry + zoom jitter) rendered at the
 *  shipped picker's level vs an adjacent level — and asks which looks
 *  better. No config authoring. Each vote POSTs to the dev middleware
 *  (`/__tune/vote`), appending a JSONL row to git-tracked
 *  the `tune` D1 database; rows carry the features a picker learner
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
 *  The current pair is URL-encoded (`?v=<slug>&z=<zoom>&l=<L>&r=<R>`) so
 *  a case can be revisited/shared, and a history panel lists past votes
 *  with in-place editing (stamping `editedTs`).
 *
 *  v3: votes live in the `tune` D1 database behind the cells-api worker
 *  (`GET/POST /v1/tune/votes`, `PATCH /v1/tune/votes/<id>`), not a
 *  git-tracked JSONL — Ryan: "I definitely don't want a Git-tracked
 *  jsonl pretending to be a DB", and a real DB is what lets others log
 *  in and vote once $oa/auth lands. Writes carry `VITE_TUNE_TOKEN` as a
 *  bearer credential (worker refuses writes when its `TUNE_TOKEN` secret
 *  is unset); reads are public.
 *
 *  v4: the 8 hand-written deck entries become 42 generated ones (all 21
 *  counties, 15 munis, 3 statewide viewports, 3 street views — `njdot
 *  tune deck`, from the muni boundary file), sampling is stratified to
 *  the least-voted view rather than uniform (the v3 stream repeated
 *  itself long before it covered anything), the vote's `view` is the
 *  durable slug rather than a display name, and the history table
 *  paginates. Fitting is `njdot tune fit`.
 *
 *  Keys: 1 left · 2 tie · 3 right · 4 finer · 5 coarser · s skip.
 *
 *  Level selection mirrors the prod picker incl. the scoped bins-budget:
 *  `areaPx = min(vpArea, scopeArea/mppx²)` (see `CrashMapSection.
 *  hexPxTarget`) — scoped views use a hardcoded approximate admin-area
 *  (km²) rather than fetching outlines; close enough for level choice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useUrlStates, defStringParam, floatParam, intParam } from "use-prms"
import { metersPerPixel } from "@/src/map/CrashMap"
import { CELLS_API_BASE } from "@/src/map/config"
import { S2_MAX_LEVEL, S2_MIN_LEVEL, S2_MIN_TARGET_PX, S2_PICK_MULT, S2_TARGET_FACTOR } from "@/src/map/s2"
import { BINS_BUDGET, autoHexPxTarget } from "@/src/map/picker"
import deck from "@/src/map/tune-deck.json"
import { MiniMap, fmtBytes, pickS2WithOverrides, type MiniMapStats } from "./TunePage"

type EvalView = {
    /** URL-param slug — short but readable (`c-huds`, `jcs`). Stable
     *  identity for the deck entry, and what's recorded as a vote's
     *  `view`: renaming `name` or reordering the deck doesn't invalidate
     *  saved links or past rows. */
    slug: string
    name: string
    /** Scale band, for stratified sampling and per-band reporting. */
    kind: "statewide" | "county" | "muni" | "street"
    lat: number
    lon: number
    zoom: number
    /** Uniform zoom jitter half-width applied when sampling this view,
     *  so votes cover the neighborhood rather than one exact zoom. */
    zoomJitter: number
    /** Admin-polygon area (km²) for scoped views; null = statewide
     *  (viewport-budgeted). */
    scopeKm2: number | null
    /** Picker viewport: homepage embed clamp, full-screen-ish, phone. */
    vp: "embed" | "full" | "phone"
}

/** All 21 counties at county-fits-viewport zoom, 15 munis spanning dense
 *  grids to sprawling townships, 3 statewide viewports and 3 street views
 *  — generated from the muni boundary file by `njdot tune deck`, so
 *  centers/areas/fit-zooms are measured rather than eyeballed.
 *
 *  Deck size is itself a fix: with the original 8 hand-written entries the
 *  stream repeated within a session, and the corpus could only speak to
 *  Hudson/Cape May/JC/Hoboken. */
const DECK = deck as EvalView[]

const VP_DIMS: Record<EvalView["vp"], [number, number]> = {
    embed: [1280, 480],
    full: [1470, 900],
    phone: [390, 700],
}

const SHIPPED = {
    targetFactor: S2_TARGET_FACTOR,
    minTargetPx: S2_MIN_TARGET_PX,
    pickMult: { ...S2_PICK_MULT },
}

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
    /** Displayed levels; one of them is `prod` (the shipped pick). */
    left: number
    right: number
    prod: number
    feats: { mppx: number; areaPx: number; autoTargetPx: number }
}

function makePair(view: EvalView, zoom: number, left: number, right: number): Pair {
    const { level: prod, ...feats } = pickWithFeatures(view, zoom)
    return { view, zoom, left, right, prod, feats }
}

/** Least-sampled deck entry, ties broken at random.
 *
 *  Uniform sampling over a 42-entry deck still clumps — the birthday
 *  problem means repeats show up long before coverage does, which is what
 *  made the v3 stream feel repetitive. Sampling from the least-voted views
 *  makes the corpus spread by construction, and matters more than usual
 *  here because the fit conditions on view-scale regimes: an unvisited
 *  county contributes nothing to the county band. */
function leastVoted(counts: Map<string, number>): EvalView {
    let min = Infinity
    for (const v of DECK) min = Math.min(min, counts.get(v.slug) ?? 0)
    const pool = DECK.filter(v => (counts.get(v.slug) ?? 0) === min)
    return pool[Math.floor(Math.random() * pool.length)]
}

function genPair(counts: Map<string, number> = new Map()): Pair {
    const view = leastVoted(counts)
    const zoom = +(view.zoom + (Math.random() * 2 - 1) * view.zoomJitter).toFixed(2)
    const { level: prod } = pickWithFeatures(view, zoom)
    // Challenger: an adjacent level, direction random (flipped at the
    // pyramid's edges). Prod-vs-neighbor is exactly the label the
    // learner needs: "was the shipped pick right, or one step off?"
    const dir = Math.random() < 0.5 ? -1 : 1
    const alt = prod + dir >= S2_MIN_LEVEL && prod + dir <= S2_MAX_LEVEL ? prod + dir : prod - dir
    const leftIsProd = Math.random() < 0.5
    return makePair(view, zoom, leftIsProd ? prod : alt, leftIsProd ? alt : prod)
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

/** One `picker_votes` row, as the worker's `/v1/tune/votes` returns it
 *  (see `cells-api/src/tune.ts`; SQL columns are flat, the wire shape
 *  nests per-side stats). */
type VoteRow = {
    id: number
    ts: string
    editedTs: string | null
    voter: string | null
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

const VOTES_URL = `${CELLS_API_BASE}/v1/tune/votes`

/** Bearer credential for vote writes. Dev-only (`www/.env.local`); the
 *  worker refuses writes when its own `TUNE_TOKEN` secret is unset, so a
 *  build without this just can't vote. */
const TUNE_TOKEN = import.meta.env.VITE_TUNE_TOKEN as string | undefined

async function postJson(url: string, method: "POST" | "PATCH", body: unknown): Promise<void> {
    if (!TUNE_TOKEN) throw new Error("VITE_TUNE_TOKEN unset — see www/.env.local")
    const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TUNE_TOKEN}` },
        body: JSON.stringify(body),
    })
    const json = await r.json().catch(() => ({}))
    if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`)
}

type Stats = { left: MiniMapStats | null; right: MiniMapStats | null }

/** History rows per page. The corpus is meant to grow into the hundreds;
 *  rendering all of it under the voting UI buries the pair being judged. */
const PAGE_SIZE = 25

/** URL params, golfed: `v` = deck slug, `z` = zoom, `l`/`r` = levels.
 *  A missing/unknown `v` means "no pinned pair" — the page samples one.
 *  `z` uses string encoding (`z=11.92`), not the default base64 float:
 *  2 decimals is all the picker resolves, and a legible zoom beats 11
 *  opaque chars for a URL meant to be eyeballed and shared. */
const URL_PARAMS = {
    v: defStringParam(""),
    z: floatParam({ default: 0, encoding: "string", decimals: 2 }),
    l: intParam(0),
    r: intParam(0),
}

export default function TuneAbPage() {
    const { values: url, setValues: setUrl } = useUrlStates(URL_PARAMS)
    const [pair, setPair] = useState<Pair | null>(() => {
        const view = DECK.find(v => v.slug === url.v)
        return view && url.z && url.l && url.r ? makePair(view, url.z, url.l, url.r) : genPair()
    })
    const [stats, setStats] = useState<Stats>({ left: null, right: null })
    const [rows, setRows] = useState<VoteRow[]>([])
    const [session, setSession] = useState(0)
    const [note, setNote] = useState("")
    const [saveError, setSaveError] = useState<string | null>(null)
    const [page, setPage] = useState(0)

    /** Votes per deck slug, driving `leastVoted`. Rows from before the
     *  deck regen recorded a display name rather than a slug; they simply
     *  don't match any current entry, which is the right answer — those
     *  views no longer exist at those coordinates. */
    const voteCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const row of rows) counts.set(row.view, (counts.get(row.view) ?? 0) + 1)
        return counts
    }, [rows])
    const countsRef = useRef(voteCounts)
    countsRef.current = voteCounts

    useEffect(() => {
        if (!pair) return
        setUrl({ v: pair.view.slug, z: pair.zoom, l: pair.left, r: pair.right })
    }, [pair, setUrl])

    const refreshRows = useCallback(() => {
        fetch(VOTES_URL)
            .then(r => r.json())
            .then(json => setRows(json.votes ?? []))
            .catch(err => setSaveError(`load: ${err}`))
    }, [])
    useEffect(() => { refreshRows() }, [refreshRows])

    const next = useCallback(() => {
        setStats({ left: null, right: null })
        setNote("")
        setPair(genPair(countsRef.current))
    }, [])

    const openRow = useCallback((row: VoteRow) => {
        const view = DECK.find(v => v.slug === row.view)
        if (!view) return  // pre-deck-regen row, or entry since removed
        setStats({ left: null, right: null })
        setNote(row.note ?? "")
        setPair(makePair(view, row.zoom, row.left.level, row.right.level))
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
        const rec = {
            ts: new Date().toISOString(),
            // Slug, not display name: it's the durable identity, it's what
            // `?v=` carries, and it's what `leastVoted` counts.
            view: pair.view.slug,
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
            await postJson(VOTES_URL, "POST", rec)
            setSaveError(null)
            setSession(s => s + 1)
            refreshRows()
            next()
        } catch (err) {
            // Leave the pair up — the vote wasn't recorded, so retrying
            // (or skipping) is the user's call.
            setSaveError(String(err))
        }
    }, [pair, stats, loaded, note, next, refreshRows])

    const updateRow = useCallback(async (row: VoteRow, patch: Partial<VoteRow>) => {
        try {
            await postJson(`${VOTES_URL}/${row.id}`, "PATCH", patch)
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

    // Rows arrive newest-first from D1, so page 0 is the most recent.
    const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1)
    const pageStart = Math.min(page, lastPage) * PAGE_SIZE
    const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE)

    return (
        <div style={{ padding: 12, fontFamily: "sans-serif", color: "#eee", background: "#111", minHeight: "100vh" }}>
            <h1 style={{ fontSize: 18, marginBottom: 4, fontWeight: 500 }}>
                Picker preference stream
                <a href="/tune" style={{ marginLeft: 12, fontSize: 13, color: "#6db3f2" }}>← /tune</a>
            </h1>
            <p style={{ fontSize: 13, color: "#aaa", marginBottom: 12 }}>
                Which binning looks better? <b>1</b> left · <b>2</b> tie · <b>3</b> right ·{" "}
                <b>4</b> neither (finer) · <b>5</b> neither (coarser) · <b>s</b> skip.
                Votes go to the <code>tune</code> D1
                {" · "}{rows.length} all-time · {session} this session ·{" "}
                {DECK.filter(v => voteCounts.has(v.slug)).length}/{DECK.length} deck views covered
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
                        {" · target "}{pair.feats.autoTargetPx.toFixed(2)}px
                        {pair.feats.autoTargetPx === SHIPPED.minTargetPx && " (at minTargetPx)"}
                        {" · vp "}{VP_DIMS[pair.view.vp].join("×")}
                        {" · "}{voteCounts.get(pair.view.slug) ?? 0} prior votes here
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 1400 }}>
                        {(["left", "right"] as const).map(sideName => {
                            const level = pair[sideName]
                            return (
                                <MiniMap
                                    key={`${sideName}-${pair.view.slug}-${pair.zoom}-${level}`}
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
                    <div style={{ fontSize: 14, marginBottom: 6, color: "#ccc", display: "flex", gap: 10, alignItems: "center" }}>
                        <span>Vote history ({rows.length})</span>
                        <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn(page > 0)}>‹ newer</button>
                        <span style={{ fontFamily: "monospace", fontSize: 12, color: "#888" }}>
                            {pageStart + 1}–{Math.min(rows.length, pageStart + PAGE_SIZE)} of {rows.length}
                        </span>
                        <button onClick={() => setPage(p => Math.min(lastPage, p + 1))} disabled={page >= lastPage} style={pageBtn(page < lastPage)}>older ›</button>
                    </div>
                    <table style={{ borderCollapse: "collapse", fontFamily: "monospace", fontSize: 12 }}>
                        <thead>
                            <tr style={{ color: "#888", textAlign: "left" }}>
                                {["when", "view", "z", "left", "right", "choice", "note", ""].map(h => (
                                    <th key={h} style={{ padding: "2px 10px 2px 0" }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {pageRows.map(row => (
                                <tr key={row.id} style={{ borderTop: "1px solid #2a2a2a" }}>
                                    <td style={{ padding: "3px 10px 3px 0", color: "#888" }} title={row.ts + (row.editedTs ? ` (edited ${row.editedTs})` : "")}>
                                        {row.ts.slice(5, 16).replace("T", " ")}{row.editedTs ? "*" : ""}
                                    </td>
                                    <td style={{ padding: "3px 10px 3px 0" }} title={row.view}>
                                        {DECK.find(v => v.slug === row.view)?.name ?? row.view}
                                    </td>
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

function pageBtn(enabled: boolean): React.CSSProperties {
    return { ...btn(enabled), padding: "1px 8px", fontSize: 12 }
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
