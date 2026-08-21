/** S2 cell math for the crash-map's dual-grid support (see
 *  `specs/s2-pyramid.md`). Sits alongside the H3 helpers in
 *  `StackedHexLayer` (H3_RADIUS_METERS) + `CrashMap` (picker) —
 *  same shape, different grid.
 *
 *  S2 vs H3 semantics (relevant to callers):
 *  - S2 cells are square (spherical quads). Level ratio is 4× area /
 *    2× linear per level (H3 is 7× area / ~2.65× linear).
 *  - S2 children exactly tile parents. Multi-level aggregation is
 *    lossless (H3 has "boundary triangle" mismatch of ~5% per level).
 *  - Cell IDs are 64-bit ints. We use `S2CellId.toToken()` (14-char
 *    hex string) as the canonical wire format — sidesteps JS's
 *    `2^53` precision ceiling and D1's lack of int64 bind types.
 *
 *  Levels of interest: 4 (shard tier, ~4200 km² ≈ NJ half) through
 *  16 (~4 m² street-scale). NJ statewide covers ~15 cells at level 4.
 */
import { S2LatLng, S2CellId } from "nodes2ts"
import { metersPerPixel } from "../CrashMap"
import { binIntoCells, type StackableCrash, type StackedHex } from "../StackedHexLayer"

export type S2Token = string

/** Edge length of an average S2 cell, in meters, at each level.
 *  Sourced from Google's published stats table (min/avg/max per
 *  level): https://s2geometry.io/resources/s2cell_statistics.html.
 *  Values below are the AVG column.
 *
 *  We use "edge" here rather than diagonal because it's the natural
 *  on-screen width — a level-N cell occupies roughly `edge/mppx`
 *  pixels wide at a given zoom, mirroring how H3 uses its vertex
 *  diameter (`2 × H3_RADIUS_METERS[r]`) in the picker.
 *
 *  Cells vary ~15% within a level (avg vs actual by latitude); the
 *  picker's boundary zooms therefore straddle levels a bit. Close
 *  enough for hex-vs-S2 aesthetic comparison. */
export const S2_DIAMETER_METERS: Record<number, number> = {
    0: 7_842_000,     // 6 faces of the cube — toy scale
    1: 3_921_000,
    2: 1_961_000,
    3: 980_000,
    4: 490_000,       // ~NJ half
    5: 245_000,
    6: 122_500,       // ~county
    7: 61_250,
    8: 30_625,        // ~large town
    9: 15_312,
    10: 7_656,        // ~urban district
    11: 3_828,        // ~city grid super-block
    12: 1_914,        // ~city block
    13: 957,          // ~half-block
    14: 478,          // ~intersection cluster
    15: 239,
    16: 120,          // ~single street segment
    17: 60,           // ~sidewalk-scale
    18: 30,           // ~single parked car
    19: 15,           // ~half an intersection / crosswalk-scale
    20: 7.5,          // ~crosswalk width
    21: 3.75,         // ~H3 r14 (the street-zoom default) — finest level we build
}

/** Level range the pyramid supports. Matches H3's r5-r15 for
 *  overlapping viewport coverage. Note `pickS2LevelForPixels` caps at
 *  the largest key in `S2_DIAMETER_METERS`, so raising this alone is
 *  not enough — the table has to grow too. */
export const S2_MIN_LEVEL = 4
export const S2_MAX_LEVEL = 21

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
 *  from `S2_DIAMETER_METERS`) we only need `center` to be right —
 *  the true 4-vertex boundary is a nice-to-have. This helper
 *  approximates a small offset-square in lat/lng around the cell
 *  center at edge/2 scale. Consumers that want the exact geodesic
 *  quad should pull it from `nodes2ts.S2CellId.toGeoJSON()`. */
export function tokenBoundary(token: S2Token): [number, number][] {
    const [lat, lng] = tokenToLatLng(token)
    const level = tokenLevel(token)
    // Half-edge in meters → degrees (approx: 1° lat ≈ 111 km).
    const halfMeters = S2_DIAMETER_METERS[level] / 2
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

/** Given a target cell-diameter (px), a zoom, and a latitude, return
 *  the finest S2 level whose *average* cell diameter is ≥ the target.
 *  Same semantics as `pickHexResolutionForPixels`: walk coarsest →
 *  finest, keep updating `best` while cells still meet the target,
 *  break when they drop below.
 *
 *  Cell diameters here are Google's published averages (see
 *  `S2_DIAMETER_METERS`); actual cell diameters vary ~15% within a
 *  level, so the picker's boundaries are approximate. For NJ latitudes
 *  the average is close to the actual, so this drift is small. */
/** S2 target scale — how much smaller than the H3-equivalent target
 *  we drive the S2 picker. Values < 1 bias toward finer S2 levels.
 *
 *  Two reasons S2 wants a smaller target than H3 at the same zoom:
 *  1. S2 levels step 2× per level (vs H3's 2.65×), so the strict `≥
 *     target` rule lands one level coarser than log-closest on half of
 *     zooms — e.g. at z=7 embed default, target 2.5px sits just above
 *     l12's 2.0px, and picker would return l11 (4.0px, sparse-looking).
 *  2. S2 cells tessellate at 100% coverage (H3 hexes ~91%), so coarse
 *     S2 cells look blockier than same-diameter H3 cells and benefit
 *     from one extra level of fineness at the aesthetic default.
 *
 *  Applied in `hexPxTargetFor` (`picker.ts`) — the picker itself still
 *  uses the strict `diameter ≥ target` rule so snap-buttons land exactly
 *  on their labelled level (a factor in the picker would push clicks one
 *  level past the labelled target).
 *
 *  0.7 keeps the wide-zoom trajectory (still lands l12 at z=6 in the embed
 *  viewport — 2.5px × 0.7 × mppx@z6 ≈ 3.2km ≥ l12's 4.9km-avg, l13 2.5km <)
 *  while ensuring l20/l21 don't get picked at every deep-zoom viewport
 *  (raised from an earlier 0.4 that pre-dated the l20/l21 extension —
 *  those levels render 1-2 css px wide, invisibly small, at the same
 *  1.0px auto target the 0.4 factor produced). */
import tuning from "../tuning.json"

/** S2 picker constants. Values come from `../tuning.json` — that file is
 *  the single source of truth, editable at `/tune` in dev mode (writes
 *  back via a Vite middleware) and committed as the shipped defaults.
 *  See docs on `S2_TARGET_FACTOR` and `S2_PICK_MULT` in the tuning JSON
 *  itself; the module keeps the exported names + types for callers. */
export const S2_TARGET_FACTOR: number = tuning.s2.targetFactor

/** Extra target multiplier for county/muni-scoped views. Scoped pages
 *  cover a small clip polygon, so the same zoom can afford much finer
 *  cells than a statewide sweep: at the Hudson z≈10.8 county view,
 *  0.25 shifts the pick two levels finer (l15 → l17: 13.3k cells /
 *  2.3 MB JSON / ~150 KB wire for the default decade, vs 1.9k / 310 KB
 *  at l15). Statewide is untouched — the same two-level shift there
 *  would be l15 = 96k cells / 16 MB / ~26 s worker. Tuned 2026-08-21
 *  from Ryan's side-by-side eval of the /map/hudson pitch view. */
export const S2_SCOPED_TARGET_FACTOR: number = tuning.s2.scopedTargetFactor ?? 1

export const S2_PICK_MULT: Record<number, number> = Object.fromEntries(
    Object.entries(tuning.s2.pickMult).map(([k, v]) => [Number(k), v as number]),
)

export function pickS2LevelForPixels(pixelTarget: number, zoom: number, lat: number): number {
    const mppx = metersPerPixel(zoom, lat)
    const targetMeters = pixelTarget * mppx
    const levels = Object.keys(S2_DIAMETER_METERS).map(Number).sort((a, b) => a - b)
    let best = levels[0]
    for (const l of levels) {
        const diaMeters = S2_DIAMETER_METERS[l] * (S2_PICK_MULT[l] ?? 1)
        if (diaMeters >= targetMeters) best = l
        else break
    }
    return best
}
