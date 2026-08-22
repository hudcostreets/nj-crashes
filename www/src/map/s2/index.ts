/** S2 cell math for the crash map (see `specs/s2-pyramid.md`). S2 is the
 *  only grid the client speaks; the H3 helpers this module was written
 *  alongside are gone (`specs/h3-removal.md`).
 *
 *  Semantics worth knowing as a caller:
 *  - S2 cells are square (spherical quads); each level is 4× the area /
 *    2× the linear size of the next.
 *  - Children exactly tile parents, so multi-level aggregation is
 *    lossless — the property that motivated leaving H3, whose
 *    "boundary triangles" mismatch ~5% per level.
 *  - Cell IDs are 64-bit ints. We use `S2CellId.toToken()` (up to 16
 *    hex chars, trailing zeros stripped) as the canonical wire format —
 *    it sidesteps JS's `2^53` precision ceiling and D1's lack of int64
 *    bind types, and lex order over tokens matches cell-id order.
 *
 *  Levels of interest: 4 (shard tier, ~490 km edge — NJ spans two of
 *  them) through 21 (~3.75 m, the finest the pyramid builds). The
 *  geometry table itself lives in `./edges` so the render layer can
 *  share it without pulling in `nodes2ts`.
 */
import { S2LatLng, S2CellId } from "nodes2ts"
import { metersPerPixel } from "../CrashMap"
import { binIntoCells, type StackableCrash, type StackedHex } from "../StackedHexLayer"
import { S2_EDGE_METERS, S2_MAX_LEVEL, S2_MIN_LEVEL, clampS2Level, s2PickEdgeMeters } from "./edges"
import tuning from "../tuning.json"

export type S2Token = string

export {
    S2_EDGE_METERS,
    S2_MIN_LEVEL,
    S2_MAX_LEVEL,
    clampS2Level,
    s2PickEdgeMeters,
} from "./edges"

/** Convert (lat, lon) → S2 cell token at `level`. Token is a
 *  14-char lowercase hex string, e.g. `"89c25c1"` (leading digits
 *  encode face + level, trailing zeros trimmed). */
export function latLngToToken(lat: number, lng: number, level: number): S2Token {
    const ll = S2LatLng.fromDegrees(lat, lng)
    const cell = S2CellId.fromPoint(ll.toPoint()).parentL(level)
    return cell.toToken()
}

/** Inverse: token → cell center (lat, lng). */
export function tokenToLatLng(token: S2Token): [number, number] {
    const cell = S2CellId.fromToken(token)
    const ll = S2LatLng.fromPoint(cell.toPoint())
    return [ll.latDegrees, ll.lngDegrees]
}

/** Level embedded in a token. Extracted from the low-order bit
 *  position of the 64-bit cell id; nodes2ts exposes it as `level()`. */
export function tokenLevel(token: S2Token): number {
    return S2CellId.fromToken(token).level()
}

/** Token's parent at `level` (< current level). Errors if `level`
 *  is not strictly less than the token's own level. */
export function tokenToParent(token: S2Token, level: number): S2Token {
    return S2CellId.fromToken(token).parentL(level).toToken()
}

/** Approximate cell boundary as a small quadrilateral around the
 *  center. S2 cells are geodesic quadrilaterals but for the crash
 *  map's render (columns extruded from a centroid, radius derived
 *  from `S2_EDGE_METERS`) we only need `center` to be right —
 *  the true 4-vertex boundary is a nice-to-have. This helper
 *  approximates a small offset-square in lat/lng around the cell
 *  center at edge/2 scale. Consumers that want the exact geodesic
 *  quad should pull it from `nodes2ts.S2CellId.toGeoJSON()`. */
export function tokenBoundary(token: S2Token): [number, number][] {
    const [lat, lng] = tokenToLatLng(token)
    const level = tokenLevel(token)
    // Half-edge in meters → degrees (approx: 1° lat ≈ 111 km).
    const halfMeters = S2_EDGE_METERS[level] / 2
    const dLat = halfMeters / 111_000
    const dLng = halfMeters / (111_000 * Math.cos((lat * Math.PI) / 180))
    return [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat],
    ]
}

/** Convenience: cell center as `[lng, lat]` (deck.gl ordering) —
 *  `tokenToLatLng` returns `[lat, lng]` to match common conventions
 *  in the rest of the codebase; this wrapper flips for render. */
export function tokenCenterLngLat(token: S2Token): [number, number] {
    const [lat, lng] = tokenToLatLng(token)
    return [lng, lat]
}

/** Client-side binning of raw crash points into S2 cells at `level`.
 *  S2 counterpart of `binIntoHexes` — used by the points-mode fetch
 *  path (`kind: "points"`) when the map is on the S2 grid, so client
 *  bins land on the same lattice as server-side pyramid cells (the
 *  H3 binner here would silently produce a hex lattice under an
 *  "S2" label). Aggregation logic is shared via `binIntoCells`. */
export function binIntoS2Cells<T extends StackableCrash>(
    crashes: T[],
    level: number,
): StackedHex[] {
    return binIntoCells(
        crashes,
        (lat, lon) => latLngToToken(lat, lon, level),
        tokenCenterLngLat,
    )
}


/** S2 picker constants. Values come from `../tuning.json` — that file is
 *  the single source of truth, editable at `/tune` in dev mode (writes
 *  back via a Vite middleware) and committed as the shipped defaults.
 *  See docs on `S2_TARGET_FACTOR` and `S2_PICK_MULT` in the tuning JSON
 *  itself; the module keeps the exported names + types for callers. */
export const S2_TARGET_FACTOR: number = tuning.s2.targetFactor

/** Lower clamp on `autoHexPxTarget`. Separate knob from `targetFactor`
 *  because the two act on disjoint regimes: county/muni-scoped views
 *  budget a small `areaPx`, so `√(areaPx/BINS_BUDGET)` lands *under* the
 *  clamp and their level is set by this alone; statewide/street views run
 *  above it and see only `targetFactor`. Fitting them jointly is what let
 *  `njdot tune fit` move statewide finer without disturbing scoped views
 *  (see `specs/tune-preference-learning.md`). */
export const S2_MIN_TARGET_PX: number = tuning.s2.minTargetPx

/** Per-level nudge on the picker's effective edge length. Lets a single
 *  level be biased without moving the whole `targetFactor` curve — used to
 *  keep l20/l21 (1-2 css px wide, invisibly small) from being selected at
 *  every deep-zoom viewport. Inverting the picker means applying this too;
 *  use `s2PickEdgeMeters`. */
export const S2_PICK_MULT: Record<number, number> = Object.fromEntries(
    Object.entries(tuning.s2.pickMult).map(([k, v]) => [Number(k), v as number]),
)

/** Finest supported level whose effective edge is still ≥ `pixelTarget`
 *  on screen.
 *
 *  Two things this deliberately does *not* do, both former bugs:
 *  - It iterates `[S2_MIN_LEVEL, S2_MAX_LEVEL]`, not every key of the edge
 *    table. The table carries levels 0-3 (continent-scale, no pyramid
 *    behind them) and the walk used to start at `levels[0]` = 0, so a
 *    large manual px target at low zoom returned l0-l3 — which
 *    `useCellsApi` then silently clamped to 4 while every debug readout
 *    kept showing the unclamped value.
 *  - It scans the whole range instead of breaking at the first level below
 *    target. `S2_PICK_MULT` makes the effective edge non-monotone in
 *    level, so an early break can stop before the finest qualifying level
 *    (today l21 would become unreachable if l20's multiplier ever dipped
 *    below l21's). */
export function pickS2LevelForPixels(pixelTarget: number, zoom: number, lat: number): number {
    const targetMeters = pixelTarget * metersPerPixel(zoom, lat)
    let best = S2_MIN_LEVEL
    for (let l = S2_MIN_LEVEL; l <= S2_MAX_LEVEL; l++) {
        if (s2PickEdgeMeters(l, S2_PICK_MULT) >= targetMeters) best = l
    }
    return clampS2Level(best)
}
