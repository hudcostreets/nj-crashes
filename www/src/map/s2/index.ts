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

export type S2Token = string

/** Vertex-diameter of an S2 cell, in meters, at each level. Averaged
 *  across mid-lat cells (S2 cells vary ~15% by lat within a level).
 *  Sourced from Google's published table:
 *  https://s2geometry.io/resources/s2cell_statistics.html
 *
 *  Callers should treat these as approximations; use `cellLevelDiam`
 *  for a specific cell's real diameter. */
export const S2_DIAMETER_METERS: Record<number, number> = {
    0: 15_755_000,   //  6 faces of the cube; toy scale
    1: 7_842_000,
    2: 3_921_000,
    3: 1_961_000,
    4: 980_000,      // ~NJ half
    5: 490_000,
    6: 245_000,
    7: 122_500,      // ~county
    8: 61_250,       // ~large town
    9: 30_625,       // ~neighborhood
    10: 15_312,      // ~urban district
    11: 7_656,       // ~city grid super-block
    12: 3_828,       // ~city block
    13: 1_914,       // ~half-block
    14: 957,         // ~intersection cluster
    15: 478,
    16: 239,         // ~single street segment
    17: 120,         // ~sidewalk-scale
}

/** Level range the pyramid supports. Matches H3's r5–r15 for
 *  overlapping viewport coverage. */
export const S2_MIN_LEVEL = 4
export const S2_MAX_LEVEL = 16

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
