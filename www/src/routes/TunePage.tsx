/** `/tune` — interactive picker-tuning gallery (dev).
 *
 *  Task #131 v1: side-by-side mini-maps for a chosen (grid, level) pair,
 *  rendered at the low-MZ and high-MZ boundaries of the zoom range where
 *  the picker chooses that level. Panning one mini-map syncs lat/lon to
 *  the other (zoom stays pinned to each boundary).
 *
 *  No editing yet — displays current shipped constants and computed
 *  boundaries for visual inspection. v2 will add editable inputs +
 *  JSON persistence via a Vite dev middleware (see task #131 desc). */
import { useCallback, useEffect, useMemo, useState } from "react"
import type { Bbox } from "@/src/map/v2"
import { CrashMap, type ViewState, metersPerPixel, pickHexResolutionForPixels } from "@/src/map/CrashMap"
import { H3_RADIUS_METERS } from "@/src/map/StackedHexLayer"
import {
    S2_DIAMETER_METERS,
    S2_MAX_LEVEL,
    S2_MIN_LEVEL,
    S2_PICK_MULT,
    S2_TARGET_FACTOR,
} from "@/src/map/s2"
import { BINS_BUDGET, autoHexPxTarget } from "@/src/map/picker"
import { useCellsApi, type CellsApiFilter } from "@/src/map/useCellsApi"

type Grid = "h3" | "s2"

const label = (grid: Grid, level: number) => (grid === "s2" ? `l${level}` : `r${level}`)

/** Picker viewport used for boundary computation — matches the shipped
 *  embed clamp so tuning reflects what a homepage user sees. Mini-map
 *  DOM sizes are separate. */
const PICK_VP_AREA = 1280 * 480

/** Default center: Jersey City intersection, has enough crash data at
 *  every level to be visually meaningful. */
const DEFAULT_LAT = 40.7203
const DEFAULT_LON = -74.0595

const MINI_HEIGHT = 300

/** Local S2 picker parameterized by the TunePage's editable state, so
 *  edits preview before Save. Mirrors `pickS2LevelForPixels` in
 *  `map/s2/index.ts` — keep the walk logic in sync. */
function pickS2WithOverrides(
    pixelTarget: number,
    zoom: number,
    lat: number,
    pickMult: Record<number, number>,
): number {
    const mppx = metersPerPixel(zoom, lat)
    const targetMeters = pixelTarget * mppx
    const levels = Object.keys(S2_DIAMETER_METERS).map(Number).sort((a, b) => a - b)
    let best = levels[0]
    for (const l of levels) {
        const diaMeters = S2_DIAMETER_METERS[l] * (pickMult[l] ?? 1)
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
    grid: Grid,
    level: number,
    lat: number,
    s2TargetFactor: number,
    s2PickMult: Record<number, number>,
): [number, number] | null {
    const baseTarget = autoHexPxTarget(PICK_VP_AREA, BINS_BUDGET)
    const target = grid === "s2" ? baseTarget * s2TargetFactor : baseTarget
    const pick = grid === "s2"
        ? (z: number) => pickS2WithOverrides(target, z, lat, s2PickMult)
        : (z: number) => pickHexResolutionForPixels(target, z, lat)
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

function bboxAround(lat: number, lon: number, zoom: number, wPx: number, hPx: number): Bbox {
    const mppx = metersPerPixel(zoom, lat)
    const wM = wPx * mppx
    const hM = hPx * mppx
    const dLat = hM / 111_000
    const dLon = wM / (111_000 * Math.cos((lat * Math.PI) / 180))
    return [lon - dLon / 2, lat - dLat / 2, lon + dLon / 2, lat + dLat / 2]
}

function MiniMap({
    lat,
    lon,
    zoom,
    grid,
    level,
    onLatLonChange,
}: {
    lat: number
    lon: number
    zoom: number
    grid: Grid
    level: number
    onLatLonChange: (lat: number, lon: number) => void
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
        grid,
    }), [lat, lon, zoom, grid, level])
    const result = useCellsApi(filter)
    const cells = result.status === "ready" ? result.data : []
    const viewState: ViewState = { longitude: lon, latitude: lat, zoom, pitch, bearing }
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
                prebinnedHexes={cells}
                grid={grid}
                dataRes={level}
                mode="hexbin"
                viz="hex"
                showInternalControls={false}
                theme="dark"
                height={MINI_HEIGHT}
            />
            <div style={{
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
                z={zoom.toFixed(2)} · {grid === "s2" ? `l${level}` : `r${level}`} · {cells.length} cells
            </div>
        </div>
    )
}

type SaveStatus = "idle" | "saving" | "saved" | "error"

export default function TunePage() {
    const [grid, setGrid] = useState<Grid>("s2")
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
        () => zoomRangeForLevel(grid, level, lat, s2Factor, s2Mult),
        [grid, level, lat, s2Factor, s2Mult],
    )

    const levels = grid === "s2"
        ? Array.from({ length: S2_MAX_LEVEL - S2_MIN_LEVEL + 1 }, (_, i) => S2_MIN_LEVEL + i)
        : [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

    // Flanking levels: prior = one coarser step, finer = one finer step.
    // The 2×2 transition view renders `prior @ its max MZ` alongside
    // `current @ its min MZ` (should look ≈ same in on-screen px if the
    // picker is well-tuned), and similarly `current @ max` vs `finer @ min`.
    const priorLevel = level - 1
    const finerLevel = level + 1
    const priorRange = useMemo(
        () => (priorLevel >= levels[0] ? zoomRangeForLevel(grid, priorLevel, lat, s2Factor, s2Mult) : null),
        [grid, priorLevel, lat, s2Factor, s2Mult, levels],
    )
    const finerRange = useMemo(
        () => (finerLevel <= levels[levels.length - 1] ? zoomRangeForLevel(grid, finerLevel, lat, s2Factor, s2Mult) : null),
        [grid, finerLevel, lat, s2Factor, s2Mult, levels],
    )

    const onLatLon = useCallback((newLat: number, newLon: number) => {
        setLat(newLat)
        setLon(newLon)
    }, [])

    const onGridChange = useCallback((newGrid: Grid) => {
        setGrid(newGrid)
        if (newGrid === "s2") setLevel(l => Math.max(S2_MIN_LEVEL, Math.min(S2_MAX_LEVEL, l)))
        else setLevel(l => Math.max(5, Math.min(15, l)))
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
            const body = {
                s2: {
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

    const geomDia = grid === "s2" ? S2_DIAMETER_METERS[level] : 2 * H3_RADIUS_METERS[level]
    const effMult = grid === "s2" ? (s2Mult[level] ?? 1) : 1
    const effDia = geomDia * effMult
    const previewMultLevels = grid === "s2"
        ? Array.from({ length: S2_MAX_LEVEL - S2_MIN_LEVEL + 1 }, (_, i) => S2_MIN_LEVEL + i)
        : []

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
                    Grid:{" "}
                    <select value={grid} onChange={e => onGridChange(e.target.value as Grid)}>
                        <option value="s2">S2</option>
                        <option value="h3">H3</option>
                    </select>
                </label>
                <label>
                    Level:{" "}
                    <select value={level} onChange={e => setLevel(+e.target.value)}>
                        {levels.map(l => (
                            <option key={l} value={l}>{grid === "s2" ? `l${l}` : `r${l}`}</option>
                        ))}
                    </select>
                </label>
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
                                <b>coarse → current</b>: {label(grid, priorLevel)} → {label(grid, level)} near z≈{priorRange[1].toFixed(2)}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <MiniMap lat={lat} lon={lon} zoom={priorRange[1]} grid={grid} level={priorLevel} onLatLonChange={onLatLon} />
                                <MiniMap lat={lat} lon={lon} zoom={range[0]} grid={grid} level={level} onLatLonChange={onLatLon} />
                            </div>
                        </div>
                    )}
                    {/* Current→finer transition. Left = current at its
                        highest MZ; right = finer at its lowest MZ. Same
                        px-equivalence check as above. */}
                    {finerRange && (
                        <div>
                            <div style={{ fontSize: 12, marginBottom: 4, color: "#aaa" }}>
                                <b>current → finer</b>: {label(grid, level)} → {label(grid, finerLevel)} near z≈{range[1].toFixed(2)}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <MiniMap lat={lat} lon={lon} zoom={range[1]} grid={grid} level={level} onLatLonChange={onLatLon} />
                                <MiniMap lat={lat} lon={lon} zoom={finerRange[0]} grid={grid} level={finerLevel} onLatLonChange={onLatLon} />
                            </div>
                        </div>
                    )}
                    {/* If both flanking ranges are missing (level is at both
                        the top and bottom of the pyramid — impossible in
                        practice, but code-safe), fall back to the standalone
                        pair like v1. */}
                    {!priorRange && !finerRange && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <MiniMap lat={lat} lon={lon} zoom={range[0]} grid={grid} level={level} onLatLonChange={onLatLon} />
                            <MiniMap lat={lat} lon={lon} zoom={range[1]} grid={grid} level={level} onLatLonChange={onLatLon} />
                        </div>
                    )}
                </div>
            ) : (
                <div style={{ padding: 24, color: "#e88", fontFamily: "monospace" }}>
                    Picker never selects {grid === "s2" ? `l${level}` : `r${level}`} in a {PICK_VP_AREA / 1000}k-px² viewport at lat={lat.toFixed(2)}.
                    {grid === "s2" && s2Mult[level] != null && (
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
                        picker zoom range for {grid === "s2" ? `l${level}` : `r${level}`}:{" "}
                        <b>z={range[0].toFixed(2)}</b> → <b>z={range[1].toFixed(2)}</b>{" "}
                        (span: {(range[1] - range[0]).toFixed(2)})
                    </div>
                )}
                <div>{grid === "s2" ? `l${level}` : `r${level}`} geometric diameter: {geomDia.toFixed(2)} m</div>
                {grid === "s2" && effMult !== 1 && (
                    <div>{`l${level}`} effective diameter (pick fudge {effMult}): {effDia.toFixed(2)} m</div>
                )}
                <div>picker vp (clamped): 1280 × 480 = {PICK_VP_AREA.toLocaleString()} px²</div>
                <div>auto target: {autoHexPxTarget(PICK_VP_AREA, BINS_BUDGET).toFixed(2)} px · S2 auto target: {(autoHexPxTarget(PICK_VP_AREA, BINS_BUDGET) * s2Factor).toFixed(2)} px</div>
                <hr style={{ border: "none", borderTop: "1px solid #333", margin: "12px 0" }} />
                {grid === "s2" ? (
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
                ) : (
                    <div style={{ color: "#888" }}>H3 tuning: no editable knobs yet.</div>
                )}
            </div>
        </div>
    )
}
