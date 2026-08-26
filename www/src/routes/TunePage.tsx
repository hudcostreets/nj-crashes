/** `/tune` — interactive picker-tuning gallery (dev).
 *
 *  Task #131 v1: side-by-side mini-maps for a chosen S2 level,
 *  rendered at the low-MZ and high-MZ boundaries of the zoom range where
 *  the picker chooses that level. Panning one mini-map syncs lat/lon to
 *  the other (zoom stays pinned to each boundary).
 *
 *  No editing yet — displays current shipped constants and computed
 *  boundaries for visual inspection. v2 will add editable inputs +
 *  JSON persistence via a Vite dev middleware (see task #131 desc). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Bbox } from "@/src/map/v2"
import { CrashMap, type ViewState, metersPerPixel } from "@/src/map/CrashMap"
import {
    S2_EDGE_METERS,
    S2_MAX_LEVEL,
    S2_MIN_LEVEL,
    S2_PICK_MULT,
    S2_TARGET_FACTOR,
} from "@/src/map/s2"
import { BINS_BUDGET, autoCellPxTarget, circleRadiusPx as circleRadiusPxCurve } from "@/src/map/picker"
import { useCellsApi, type CellsApiFilter } from "@/src/map/useCellsApi"
import tuning from "@/src/map/tuning.json"

/** Which curve drives `circleRadiusPx` (the per-frame render-size override).
 *  - `curve`: production `circleRadiusPx(zoom)` curve from `picker.ts`.
 *  - `df`: linear DF sweep within the level's picker zoom range (see
 *    `dfOverridePx`) — target of #132.
 *  - `inscribed`: no override; layer falls back to full inscribed (2:1 step
 *    at every crossover, matches TunePage v1's original behavior). */
type RenderMode = "curve" | "df" | "inscribed"

const label = (level: number) => `l${level}`

/** DF continuity ratio: at level L's max-MZ, we want the drawn radius to
 *  equal the finer level's inscribed radius, so the crossover looks
 *  continuous. That ratio is `new_inscribed / old_inscribed = new_edge /
 *  old_edge`; S2 halves per level. */
const CONTINUITY_RATIO = 0.5

/** Picker viewport used for boundary computation — matches the shipped
 *  embed clamp so tuning reflects what a homepage user sees. Mini-map
 *  DOM sizes are separate. */
const PICK_VP_AREA = 1280 * 480

/** Default center: Jersey City intersection, has enough crash data at
 *  every level to be visually meaningful. */
const DEFAULT_LAT = 40.7203
const DEFAULT_LON = -74.0595

export const MINI_HEIGHT = 300

/** Fetch metrics reported by a `MiniMap` (see `onStats`). `ms` is
 *  perceived load time (null until measured); byte fields are null until
 *  the plan resolves, and `wireBytes` 0 means "unknown" (no Resource
 *  Timing entry), not free. */
export type MiniMapStats = {
    cells: number
    ms: number | null
    bodyBytes: number | null
    wireBytes: number | null
}

export function fmtBytes(b: number | null): string {
    if (b === null) return "?"
    if (b === 0) return "0?"
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`
    if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`
    return `${b}B`
}

/** Local S2 picker parameterized by the TunePage's editable state, so
 *  edits preview before Save. Mirrors `pickS2LevelForPixels` in
 *  `map/s2/index.ts` — keep the walk logic in sync. */
export function pickS2WithOverrides(
    pixelTarget: number,
    zoom: number,
    lat: number,
    pickMult: Record<number, number>,
): number {
    const mppx = metersPerPixel(zoom, lat)
    const targetMeters = pixelTarget * mppx
    const levels = Object.keys(S2_EDGE_METERS).map(Number).sort((a, b) => a - b)
    let best = levels[0]
    for (const l of levels) {
        const diaMeters = S2_EDGE_METERS[l] * (pickMult[l] ?? 1)
        if (diaMeters >= targetMeters) best = l
        else break
    }
    return best
}

/** Sweep zoom in small steps, find [lowZ, highZ] where the picker
 *  returns the target level. Returns null if the level is unreachable
 *  with the current constants (which is a useful signal — e.g. the
 *  picker never picks l21 in the embed viewport).
 *
 *  For the finest reachable level the picker keeps returning it as we
 *  zoom in without bound; we cap `highZ` at `MAX_PRACTICAL_ZOOM` so the
 *  "highest MZ" mini-map shows a viewport with actual content rather
 *  than a sub-meter empty scene at z=22. */
const MAX_PRACTICAL_ZOOM = 19
function zoomRangeForLevel(
    level: number,
    lat: number,
    s2TargetFactor: number,
    s2PickMult: Record<number, number>,
): [number, number] | null {
    const target = autoCellPxTarget(PICK_VP_AREA, BINS_BUDGET) * s2TargetFactor
    const pick = (z: number) => pickS2WithOverrides(target, z, lat, s2PickMult)
    let low = -1, high = -1
    for (let z = 2; z <= MAX_PRACTICAL_ZOOM; z += 0.02) {
        if (pick(z) === level) {
            if (low < 0) low = z
            high = z
        }
    }
    if (low < 0) return null
    return [low, high]
}

/** DF (drawn fraction) mechanic — proposed #132 render curve. Linear
 *  interpolation from `dfStart` at the level's min-MZ to `dfEnd` at its
 *  max-MZ. Continuity at crossovers is by convention when
 *  `dfEnd = CONTINUITY_RATIO`:
 *    render(zHi, L)   = dfEnd × inscribed_L
 *                     = ratio × inscribed_L
 *                     = inscribed_{L+1}                (by ratio definition)
 *                     = dfStart × inscribed_{L+1}     (when dfStart = 1.0)
 *                     = render(zLo, L+1)
 *  Raising `dfEnd` above `ratio` trades continuity for less shrinkage
 *  within a level (fewer visible pointillism gaps at deep zoom). Values
 *  > 1.0 deliberately overlap adjacent cells — useful at sparse-cell
 *  levels but visually noisy at dense ones. Returns undefined if the
 *  level's picker zoom range isn't known (e.g. finest level with no
 *  successor); callers fall back to the layer's own inscribed cap. */
function dfOverridePx(
    zoom: number,
    lat: number,
    level: number,
    range: [number, number] | null,
    dfStart: number,
    dfEnd: number,
): number | undefined {
    if (!range) return undefined
    const [zLo, zHi] = range
    const span = zHi - zLo
    const t = span > 0 ? Math.max(0, Math.min(1, (zoom - zLo) / span)) : 0
    const df = dfStart + (dfEnd - dfStart) * t
    const inscribedMeters = (S2_EDGE_METERS[level] ?? 0) / 2
    const inscribedPx = inscribedMeters / metersPerPixel(zoom, lat)
    return df * inscribedPx
}

function bboxAround(lat: number, lon: number, zoom: number, wPx: number, hPx: number): Bbox {
    const mppx = metersPerPixel(zoom, lat)
    const wM = wPx * mppx
    const hM = hPx * mppx
    const dLat = hM / 111_000
    const dLon = wM / (111_000 * Math.cos((lat * Math.PI) / 180))
    return [lon - dLon / 2, lat - dLat / 2, lon + dLon / 2, lat + dLat / 2]
}

export function MiniMap({
    lat,
    lon,
    zoom,
    level,
    renderMode,
    showLabel = true,
    range,
    dfStart,
    dfEnd,
    onLatLonChange,
    onStats,
}: {
    lat: number
    lon: number
    zoom: number
    level: number
    renderMode: RenderMode
    /** Picker's [min-MZ, max-MZ] for THIS map's level — used by
     *  `dfOverridePx`. Null if unreachable in the current picker
     *  config (rare; DF mode then falls back to inscribed). */
    range: [number, number] | null
    /** DF endpoints in effect (both = 1.0 collapses to `inscribed` mode
     *  behavior; dfEnd = CONTINUITY_RATIO is the smooth-crossover
     *  default). */
    dfStart: number
    dfEnd: number
    onLatLonChange: (lat: number, lon: number) => void
    /** Hide the corner readout (z / level / cell count) — used by the
     *  `/tune/ab` blind-vote flow, where the level would unblind. */
    showLabel?: boolean
    /** Reports fetch metrics for the current {lat, lon, zoom, level} —
     *  fires each time the cells API resolves (twice per view: once with
     *  `ms: null`, again once load time is measured). Used by `/tune/ab`
     *  to record real bins/bytes/latency per side in vote rows (features
     *  the picker learner conditions on). */
    onStats?: (s: MiniMapStats) => void
}) {
    const [pitch, setPitch] = useState(20)
    const [bearing, setBearing] = useState(1)
    const filter = useMemo<CellsApiFilter>(() => ({
        yearRange: [2001, 2026],
        severities: new Set(["f", "i", "p"]),
        viewport: bboxAround(lat, lon, zoom, 640, MINI_HEIGHT),
        viewportLat: lat,
        zoom,
        resOverride: level,
    }), [lat, lon, zoom, level])
    const result = useCellsApi(filter)
    const cells = result.status === "ready" ? result.data : []
    const ready = result.status === "ready"
    const cellCount = cells.length
    const plan = result.status === "ready" ? result.plan : undefined
    // Perceived load time: filter change → cells resolved. Includes the
    // hook's debounce for uncached views; near-0 for cache hits — which
    // is the honest user-experienced number in both cases.
    const t0Ref = useRef(performance.now())
    const [fetchMs, setFetchMs] = useState<number | null>(null)
    useEffect(() => {
        t0Ref.current = performance.now()
        setFetchMs(null)
    }, [filter])
    useEffect(() => {
        if (ready && fetchMs === null) setFetchMs(Math.round(performance.now() - t0Ref.current))
    }, [ready, fetchMs])
    const bodyBytes = plan?.fetchedBytes ?? null
    const wireBytes = plan?.wireBytes ?? null
    useEffect(() => {
        if (ready) onStats?.({ cells: cellCount, ms: fetchMs, bodyBytes, wireBytes })
    }, [ready, cellCount, fetchMs, bodyBytes, wireBytes, onStats])
    const viewState: ViewState = { longitude: lon, latitude: lat, zoom, pitch, bearing }
    // The `circleRadiusPx` prop picked based on the current `renderMode`:
    //   curve     — production `circleRadiusPx(zoom)` from picker.ts
    //   df        — linear DF sweep within level's picker range (task #132)
    //   inscribed — no override; layer falls back to inscribed cap
    const overridePx = renderMode === "curve"
        ? circleRadiusPxCurve(zoom)
        : renderMode === "df"
            ? dfOverridePx(zoom, lat, level, range, dfStart, dfEnd)
            : undefined
    // Compute the numbers surfaced in the corner label:
    //   geom   — cell's geometric on-screen size (edge / mppx). Halves per
    //            S2 level regardless of render mode.
    //   render — what the layer will actually draw, per StackedCellLayer's
    //            `min(overrideRadiusMeters ?? inscribed, inscribed)` rule.
    //            H3 hex mode with no override falls back to full edge.
    const mppx = metersPerPixel(zoom, lat)
    const cellMeters = S2_EDGE_METERS[level] ?? 0
    const geomPx = cellMeters / mppx
    const inscribedPx = geomPx / 2
    const renderPx = Math.min(overridePx ?? inscribedPx, inscribedPx)
    const onViewStateChange = useCallback((v: ViewState) => {
        setPitch(v.pitch)
        setBearing(v.bearing)
        onLatLonChange(v.latitude, v.longitude)
    }, [onLatLonChange])
    return (
        <div style={{ position: "relative", height: MINI_HEIGHT, borderRadius: 4, overflow: "hidden" }}>
            <CrashMap
                viewState={viewState}
                onViewStateChange={onViewStateChange}
                prebinnedCells={cells}
                dataRes={level}
                mode="bins"
                circleRadiusPx={overridePx}
                showInternalControls={false}
                theme="dark"
                height={MINI_HEIGHT}
            />
            {showLabel && <div style={{
                position: "absolute",
                top: 6,
                left: 6,
                background: "rgba(0,0,0,0.7)",
                color: "#eee",
                padding: "3px 8px",
                fontSize: 12,
                fontFamily: "monospace",
                borderRadius: 3,
                pointerEvents: "none",
            }}>
                z={zoom.toFixed(2)} · l{level} · {cells.length} cells
                {" · geom="}{geomPx.toFixed(2)}{"px"}
                {" · render="}{renderPx.toFixed(2)}{"px"}
                <br />
                {fmtBytes(bodyBytes)} body · {fmtBytes(wireBytes)} wire · {fetchMs === null ? "…" : `${fetchMs}ms`}
            </div>}
        </div>
    )
}

type SaveStatus = "idle" | "saving" | "saved" | "error"

export default function TunePage() {
    const [renderMode, setRenderMode] = useState<RenderMode>("curve")
    // DF endpoints — see `dfOverridePx`. Default `dfEnd` is the S2
    // continuity ratio; user can push it toward 1.0 to trade continuity
    // for less pointillism, or over 1.0 for deliberate overlap at
    // sparse-cell zooms.
    const [dfStart, setDfStart] = useState(1.0)
    const [dfEnd, setDfEnd] = useState(0.5)
    const [level, setLevel] = useState(19)
    const [lat, setLat] = useState(DEFAULT_LAT)
    const [lon, setLon] = useState(DEFAULT_LON)

    // Editable tuning state — initialized from the imported (shipped)
    // constants. All picker previews use these; Save writes back to
    // `src/map/tuning.json` and Vite HMR reloads the app.
    const [s2Factor, setS2Factor] = useState<number>(S2_TARGET_FACTOR)
    const [s2Mult, setS2Mult] = useState<Record<number, number>>({ ...S2_PICK_MULT })
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
    const [saveMsg, setSaveMsg] = useState<string>("")

    // Track whether the local state has drifted from the imported
    // (last-saved) values, so the Save button can indicate "dirty".
    const dirty = useMemo(() => {
        if (s2Factor !== S2_TARGET_FACTOR) return true
        const keys = new Set([...Object.keys(s2Mult), ...Object.keys(S2_PICK_MULT).map(String)])
        for (const k of keys) {
            if ((s2Mult[+k] ?? 1) !== (S2_PICK_MULT[+k] ?? 1)) return true
        }
        return false
    }, [s2Factor, s2Mult])

    // When the imported constants change (HMR after a save), re-sync
    // local state — otherwise the "dirty" indicator would show forever.
    useEffect(() => {
        setS2Factor(S2_TARGET_FACTOR)
        setS2Mult({ ...S2_PICK_MULT })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])  // Only on mount; HMR does a fresh mount.

    const range = useMemo(
        () => zoomRangeForLevel(level, lat, s2Factor, s2Mult),
        [level, lat, s2Factor, s2Mult],
    )

    const levels = Array.from({ length: S2_MAX_LEVEL - S2_MIN_LEVEL + 1 }, (_, i) => S2_MIN_LEVEL + i)

    // Flanking levels: prior = one coarser step, finer = one finer step.
    // The 2×2 transition view renders `prior @ its max MZ` alongside
    // `current @ its min MZ` (should look ≈ same in on-screen px if the
    // picker is well-tuned), and similarly `current @ max` vs `finer @ min`.
    const priorLevel = level - 1
    const finerLevel = level + 1
    const priorRange = useMemo(
        () => (priorLevel >= levels[0] ? zoomRangeForLevel(priorLevel, lat, s2Factor, s2Mult) : null),
        [priorLevel, lat, s2Factor, s2Mult, levels],
    )
    const finerRange = useMemo(
        () => (finerLevel <= levels[levels.length - 1] ? zoomRangeForLevel(finerLevel, lat, s2Factor, s2Mult) : null),
        [finerLevel, lat, s2Factor, s2Mult, levels],
    )

    const onLatLon = useCallback((newLat: number, newLon: number) => {
        setLat(newLat)
        setLon(newLon)
    }, [])

    const onMultChange = useCallback((lvl: number, v: string) => {
        const n = parseFloat(v)
        setS2Mult(prev => {
            const next = { ...prev }
            if (!v || isNaN(n)) delete next[lvl]
            else next[lvl] = n
            return next
        })
    }, [])

    const onSave = useCallback(async () => {
        setSaveStatus("saving")
        setSaveMsg("")
        try {
            // Spread the shipped object so fields this page doesn't edit
            // (e.g. `scopedTargetFactor`) round-trip instead of being
            // clobbered by Save.
            const body = {
                ...tuning,
                s2: {
                    ...tuning.s2,
                    targetFactor: s2Factor,
                    pickMult: Object.fromEntries(Object.entries(s2Mult).map(([k, v]) => [k, v])),
                },
            }
            const r = await fetch("/__tune/write", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            const json = await r.json()
            if (!r.ok || !json.ok) throw new Error(json.error ?? `HTTP ${r.status}`)
            setSaveStatus("saved")
            setSaveMsg(`wrote ${json.file}`)
        } catch (err) {
            setSaveStatus("error")
            setSaveMsg(String(err))
        }
    }, [s2Factor, s2Mult])

    const geomDia = S2_EDGE_METERS[level]
    const effMult = s2Mult[level] ?? 1
    const effDia = geomDia * effMult
    const previewMultLevels = Array.from({ length: S2_MAX_LEVEL - S2_MIN_LEVEL + 1 }, (_, i) => S2_MIN_LEVEL + i)

    return (
        <div style={{
            padding: 12,
            fontFamily: "sans-serif",
            color: "#eee",
            background: "#111",
            minHeight: "100vh",
        }}>
            <h1 style={{ fontSize: 18, marginBottom: 12, fontWeight: 500 }}>Picker Tuning</h1>
            <div style={{ display: "flex", gap: 16, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label>
                    Level:{" "}
                    <select value={level} onChange={e => setLevel(+e.target.value)}>
                        {levels.map(l => (
                            <option key={l} value={l}>l{l}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Render:{" "}
                    <select value={renderMode} onChange={e => setRenderMode(e.target.value as RenderMode)}>
                        <option value="curve">curve (shipped)</option>
                        <option value="df">DF (proposed #132)</option>
                        <option value="inscribed">inscribed (no override)</option>
                    </select>
                </label>
                {renderMode === "df" && (
                    <>
                        <label style={{ fontFamily: "monospace", fontSize: 12 }}>
                            dfStart:{" "}
                            <input
                                type="number" step="0.05" min="0.1" max="2"
                                value={dfStart}
                                onChange={e => setDfStart(parseFloat(e.target.value) || 0)}
                                style={{ width: 60, fontFamily: "monospace" }}
                            />
                        </label>
                        <label style={{ fontFamily: "monospace", fontSize: 12 }}>
                            dfEnd:{" "}
                            <input
                                type="number" step="0.05" min="0.1" max="2"
                                value={dfEnd}
                                onChange={e => setDfEnd(parseFloat(e.target.value) || 0)}
                                style={{ width: 60, fontFamily: "monospace" }}
                            />
                            <span style={{ color: "#888", marginLeft: 4 }}>
                                (continuity: {CONTINUITY_RATIO.toFixed(3)})
                            </span>
                        </label>
                    </>
                )}
                <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                    lat={lat.toFixed(4)} · lon={lon.toFixed(4)}
                </span>
            </div>
            {range ? (
                <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
                    {/* Coarse→current transition. Left = prior level at its
                        highest MZ (picker about to switch up); right =
                        current level at its lowest MZ (just switched).
                        Zooms differ by the sweep step (~0.02); on-screen cell
                        sizes SHOULD look ~equal if the picker's well-tuned. */}
                    {priorRange && (
                        <div>
                            <div style={{ fontSize: 12, marginBottom: 4, color: "#aaa" }}>
                                <b>coarse → current</b>: {label(priorLevel)} → {label(level)} near z≈{priorRange[1].toFixed(2)}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <MiniMap lat={lat} lon={lon} zoom={priorRange[1]} level={priorLevel} renderMode={renderMode} range={priorRange} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                                <MiniMap lat={lat} lon={lon} zoom={range[0]} level={level} renderMode={renderMode} range={range} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                            </div>
                        </div>
                    )}
                    {/* Current→finer transition. Left = current at its
                        highest MZ; right = finer at its lowest MZ. Same
                        px-equivalence check as above. */}
                    {finerRange && (
                        <div>
                            <div style={{ fontSize: 12, marginBottom: 4, color: "#aaa" }}>
                                <b>current → finer</b>: {label(level)} → {label(finerLevel)} near z≈{range[1].toFixed(2)}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <MiniMap lat={lat} lon={lon} zoom={range[1]} level={level} renderMode={renderMode} range={range} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                                <MiniMap lat={lat} lon={lon} zoom={finerRange[0]} level={finerLevel} renderMode={renderMode} range={finerRange} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                            </div>
                        </div>
                    )}
                    {/* If both flanking ranges are missing (level is at both
                        the top and bottom of the pyramid — impossible in
                        practice, but code-safe), fall back to the standalone
                        pair like v1. */}
                    {!priorRange && !finerRange && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <MiniMap lat={lat} lon={lon} zoom={range[0]} level={level} renderMode={renderMode} range={range} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                            <MiniMap lat={lat} lon={lon} zoom={range[1]} level={level} renderMode={renderMode} range={range} dfStart={dfStart} dfEnd={dfEnd} onLatLonChange={onLatLon} />
                        </div>
                    )}
                </div>
            ) : (
                <div style={{ padding: 24, color: "#e88", fontFamily: "monospace" }}>
                    Picker never selects {`l${level}`} in a {PICK_VP_AREA / 1000}k-px² viewport at lat={lat.toFixed(2)}.
                    {s2Mult[level] != null && (
                        <> Try lowering <code>s2.pickMult[{level}]</code> (currently {s2Mult[level]}).</>
                    )}
                </div>
            )}
            <div style={{
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.6,
                background: "#1a1a1a",
                padding: 12,
                borderRadius: 4,
                border: "1px solid #333",
            }}>
                {range && (
                    <div>
                        picker zoom range for {`l${level}`}:{" "}
                        <b>z={range[0].toFixed(2)}</b> → <b>z={range[1].toFixed(2)}</b>{" "}
                        (span: {(range[1] - range[0]).toFixed(2)})
                    </div>
                )}
                <div>{`l${level}`} geometric diameter: {geomDia.toFixed(2)} m</div>
                {effMult !== 1 && (
                    <div>{`l${level}`} effective diameter (pick fudge {effMult}): {effDia.toFixed(2)} m</div>
                )}
                <div>picker vp (clamped): 1280 × 480 = {PICK_VP_AREA.toLocaleString()} px²</div>
                <div>auto target: {autoCellPxTarget(PICK_VP_AREA, BINS_BUDGET).toFixed(2)} px · S2 auto target: {(autoCellPxTarget(PICK_VP_AREA, BINS_BUDGET) * s2Factor).toFixed(2)} px</div>
                <hr style={{ border: "none", borderTop: "1px solid #333", margin: "12px 0" }} />
                {(
                    <div>
                        <div style={{ marginBottom: 8, fontSize: 13 }}>
                            <b>edit S2 tuning</b> (previews live; Save writes to <code>src/map/tuning.json</code>)
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                            <label>targetFactor:</label>
                            <input
                                type="number"
                                step="0.05"
                                min="0.1"
                                max="3"
                                value={s2Factor}
                                onChange={e => setS2Factor(parseFloat(e.target.value) || 0)}
                                style={{ width: 80, fontFamily: "monospace" }}
                            />
                            <span style={{ color: "#888" }}>(shipped: {S2_TARGET_FACTOR})</span>
                        </div>
                        <div style={{ marginBottom: 6 }}>pickMult (leave blank for default 1.0):</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, auto)", gap: "4px 12px", marginLeft: 12 }}>
                            {previewMultLevels.map(l => (
                                <label key={l} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                    l{l}:
                                    <input
                                        type="number"
                                        step="0.05"
                                        min="0.05"
                                        max="2"
                                        placeholder="1.0"
                                        value={s2Mult[l] ?? ""}
                                        onChange={e => onMultChange(l, e.target.value)}
                                        style={{ width: 60, fontFamily: "monospace" }}
                                    />
                                </label>
                            ))}
                        </div>
                        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                            <button
                                onClick={onSave}
                                disabled={saveStatus === "saving" || !dirty}
                                style={{
                                    padding: "4px 12px",
                                    background: dirty ? "#2a4" : "#333",
                                    color: "#eee",
                                    border: "1px solid #555",
                                    borderRadius: 3,
                                    cursor: dirty ? "pointer" : "default",
                                }}
                            >
                                {dirty ? "Save to tuning.json" : "no changes"}
                            </button>
                            {saveStatus === "saving" && <span>saving…</span>}
                            {saveStatus === "saved" && <span style={{ color: "#7d7" }}>✓ {saveMsg}</span>}
                            {saveStatus === "error" && <span style={{ color: "#e77" }}>✗ {saveMsg}</span>}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
