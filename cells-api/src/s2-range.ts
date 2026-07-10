/** S2 cell ID bit manipulation for prefix-pruning queries on a
 *  base-level table. Mirrors `h3-range.ts`'s job for the H3 grid.
 *
 *  S2 cell ID layout (64 bits, MSB → LSB), per Google's S2 encoding
 *  and confirmed against `njdot/s2.py` on the Python side:
 *
 *      3 face bits | 2N digit bits | 1 marker bit | (60 - 2N) zero bits
 *
 *  where N is the cell's level (0-30). The single "1" marker bit sits
 *  at position `2 * (30 - N)` and separates the meaningful digits from
 *  the trailing zero-fill. All 4 leaf-descendants of a level-N cell at
 *  level (N+1) collapse the parent's marker bit into the top bit of a
 *  new 2-bit digit, and place a new marker two positions lower.
 *
 *  For a uniform base-level B table sorted numerically, the base-level
 *  descendants of any ancestor cell P at level N (N < B) share P's
 *  bits above `2 * (30 - N)` exactly, and vary only in the (B - N) new
 *  digits between the two markers. So descendants form a contiguous
 *  numerical range — exploitable as parquet row-group pruning or D1
 *  `cellid BETWEEN lo AND hi` filtering.
 *
 *  Range closed form (derived + verified in the tests):
 *
 *      parent_lsb = 1 << 2 * (30 - N)
 *      child_lsb  = 1 << 2 * (30 - B)
 *      lo = P - parent_lsb + child_lsb
 *      hi = P + parent_lsb - child_lsb
 *
 *  Token format matches `njdot/s2.py` and `nodes2ts`: uint64 → 16-char
 *  lowercase hex with trailing zeros stripped, or `"X"` for id 0.
 *  Same tokens the client + Python builder use — a range query built
 *  here lines up with the cellid TEXT column in the D1 rollup.
 */

/** Level of the S2 leaf cells; every level's marker bit sits at
 *  `2 * (LEAF_LEVEL - level)`. */
export const S2_LEAF_LEVEL = 30

/** Marker bit for a cell at `level` — the single "1" bit that
 *  separates real digits from trailing zeros. */
export function s2LsbForLevel(level: number): bigint {
    if (level < 0 || level > S2_LEAF_LEVEL) {
        throw new Error(`bad S2 level ${level}`)
    }
    return 1n << BigInt(2 * (S2_LEAF_LEVEL - level))
}

/** Extract the level of an S2 cell id — the position of the low-order
 *  1 bit tells us where the marker is. */
export function s2LevelOf(id: bigint): number {
    if (id === 0n) throw new Error("zero cell id has no level")
    // Position of lowest set bit = trailing zero count.
    let tz = 0
    let v = id
    while ((v & 1n) === 0n) { v >>= 1n; tz++ }
    // Marker at 2*(30-N) → tz must be even, N = 30 - tz/2.
    if (tz % 2 !== 0) throw new Error(`odd marker bit position ${tz} — not a valid cell id`)
    return S2_LEAF_LEVEL - tz / 2
}

/** Cell id of the ancestor at `targetLevel`. Errors if `targetLevel`
 *  is not strictly less than the cell's own level. */
export function s2Parent(id: bigint, targetLevel: number): bigint {
    const own = s2LevelOf(id)
    if (targetLevel >= own) {
        throw new Error(`target level ${targetLevel} not coarser than cell level ${own}`)
    }
    const lsb = s2LsbForLevel(targetLevel)
    // Clear everything below the target marker, then set the marker.
    return (id & ~(lsb - 1n)) | lsb
}

/** Parse a token — hex, trailing zeros stripped, or `"X"` for id 0 —
 *  back to a bigint cell id. */
export function s2TokenToId(token: string): bigint {
    if (token === "X" || token === "x") return 0n
    if (token.length === 0 || token.length > 16) {
        throw new Error(`bad S2 token "${token}"`)
    }
    // Right-pad with zeros to 16 chars, then parse as base-16.
    const padded = token + "0".repeat(16 - token.length)
    return BigInt("0x" + padded)
}

/** Inverse: format a bigint cell id back to a token. */
export function s2IdToToken(id: bigint): string {
    if (id === 0n) return "X"
    if (id < 0n) throw new Error("negative cell id")
    const hex = id.toString(16).padStart(16, "0")
    const trimmed = hex.replace(/0+$/, "")
    // A non-zero id must have at least the marker bit → at least one
    // non-zero nibble → the trim result can't be empty.
    return trimmed
}

/** Inclusive `[lo, hi]` range of base-level cell ids that descend from
 *  `parent` at some level N ≤ `baseLevel`. When N == baseLevel, the
 *  range collapses to `parent, parent`. */
export type S2CellRange = { lo: bigint; hi: bigint }

export function s2RangeForCell(parent: bigint, baseLevel: number): S2CellRange {
    const parentLevel = s2LevelOf(parent)
    if (baseLevel < parentLevel) {
        throw new Error(`baseLevel ${baseLevel} coarser than parent level ${parentLevel}`)
    }
    if (baseLevel === parentLevel) {
        return { lo: parent, hi: parent }
    }
    const parentLsb = s2LsbForLevel(parentLevel)
    const childLsb  = s2LsbForLevel(baseLevel)
    return {
        lo: parent - parentLsb + childLsb,
        hi: parent + parentLsb - childLsb,
    }
}

/** Same, but with tokens on the outside — convenient for callers that
 *  read a shard/parent token from the manifest or client request and
 *  want the base-level range as tokens (for D1 `cellid BETWEEN lo AND
 *  hi` on the TEXT column). */
export function s2RangeForCellToken(
    parentToken: string,
    baseLevel: number,
): { lo: string; hi: string } {
    const parent = s2TokenToId(parentToken)
    const { lo, hi } = s2RangeForCell(parent, baseLevel)
    return { lo: s2IdToToken(lo), hi: s2IdToToken(hi) }
}
