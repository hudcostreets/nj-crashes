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
import { useCallback, useMemo, useState } from "react"
import type { Bbox } from "@/src/map/v2"
import { CrashMap, type ViewState, metersPerPixel, pickHexResolutionForPixels } from "@/src/map/CrashMap"
import { H3_RADIUS_METERS } from "@/src/map/StackedHexLayer"
import {
    S2_DIAMETER_METERS,
    S2_MAX_LEVEL,
    S2_MIN_LEVEL,
    S2_PICK_MULT,
    S2_TARGET_FACTOR,
    pickS2LevelForPixels,
} from "@/src/map/s2"
import { BINS_BUDGET, hexPxTargetFor } from "@/src/map/picker"
import { useCellsApi, type CellsApiFilter } from "@/src/map/useCellsApi"

type Grid = "h3" | "s2"

/** Picker viewport used for boundary computation — matches the shipped
 *  embed clamp so tuning reflects what a homepage user sees. Mini-map
 *  DOM sizes are separate. */
const PICK_VP_AREA = 1280 * 480

/** Default center: Jersey City intersection, has enough crash data at
 *  every level to be visually meaningful. */
const DEFAULT_LAT = 40.7203
const DEFAULT_LON = -74.0595

const MINI_HEIGHT = 380

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
function zoomRangeForLevel(grid: Grid, level: number, lat: number): [number, number] | null {
    const target = hexPxTargetFor("circle", PICK_VP_AREA, BINS_BUDGET, grid)
    const pick = grid === "s2"
        ? (z: number) => pickS2LevelForPixels(target, z, lat)
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
                viz="circle"
                circleRadiusPx={5}
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

export default function TunePage() {
    const [grid, setGrid] = useState<Grid>("s2")
    const [level, setLevel] = useState(19)
    const [lat, setLat] = useState(DEFAULT_LAT)
    const [lon, setLon] = useState(DEFAULT_LON)

    const range = useMemo(() => zoomRangeForLevel(grid, level, lat), [grid, level, lat])

    const levels = grid === "s2"
        ? Array.from({ length: S2_MAX_LEVEL - S2_MIN_LEVEL + 1 }, (_, i) => S2_MIN_LEVEL + i)
        : [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

    const onLatLon = useCallback((newLat: number, newLon: number) => {
        setLat(newLat)
        setLon(newLon)
    }, [])

    const onGridChange = useCallback((newGrid: Grid) => {
        setGrid(newGrid)
        // Clamp level to the new grid's range so we don't sit on an
        // invalid choice (e.g. l21 doesn't exist for H3).
        if (newGrid === "s2") setLevel(l => Math.max(S2_MIN_LEVEL, Math.min(S2_MAX_LEVEL, l)))
        else setLevel(l => Math.max(5, Math.min(15, l)))
    }, [])

    const geomDia = grid === "s2" ? S2_DIAMETER_METERS[level] : 2 * H3_RADIUS_METERS[level]
    const effMult = grid === "s2" ? (S2_PICK_MULT[level] ?? 1) : 1
    const effDia = geomDia * effMult

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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                    <div>
                        <div style={{ fontSize: 12, marginBottom: 4, color: "#aaa" }}>
                            lowest MZ (just entered {grid === "s2" ? `l${level}` : `r${level}`})
                        </div>
                        <MiniMap lat={lat} lon={lon} zoom={range[0]} grid={grid} level={level} onLatLonChange={onLatLon} />
                    </div>
                    <div>
                        <div style={{ fontSize: 12, marginBottom: 4, color: "#aaa" }}>
                            highest MZ (about to leave for finer)
                        </div>
                        <MiniMap lat={lat} lon={lon} zoom={range[1]} grid={grid} level={level} onLatLonChange={onLatLon} />
                    </div>
                </div>
            ) : (
                <div style={{ padding: 24, color: "#e88", fontFamily: "monospace" }}>
                    Picker never selects {grid === "s2" ? `l${level}` : `r${level}`} in a {PICK_VP_AREA / 1000}k-px² viewport at lat={lat.toFixed(2)}.
                    {grid === "s2" && S2_PICK_MULT[level] != null && (
                        <> Try lowering <code>S2_PICK_MULT[{level}]</code> (currently {S2_PICK_MULT[level]}).</>
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
                <hr style={{ border: "none", borderTop: "1px solid #333", margin: "8px 0" }} />
                {grid === "s2" ? (
                    <>
                        <div>S2_TARGET_FACTOR = {S2_TARGET_FACTOR}</div>
                        <div>S2_PICK_MULT = {JSON.stringify(S2_PICK_MULT)}</div>
                        <div>picker vp (clamped): 1280 × 480 = {PICK_VP_AREA.toLocaleString()} px²</div>
                        <div>auto target: {hexPxTargetFor("circle", PICK_VP_AREA, BINS_BUDGET, "s2").toFixed(2)} px</div>
                    </>
                ) : (
                    <>
                        <div>picker vp (clamped): 1280 × 480 = {PICK_VP_AREA.toLocaleString()} px²</div>
                        <div>auto target: {hexPxTargetFor("circle", PICK_VP_AREA, BINS_BUDGET, "h3").toFixed(2)} px</div>
                    </>
                )}
            </div>
        </div>
    )
}
