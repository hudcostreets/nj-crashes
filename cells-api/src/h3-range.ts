/** H3 cell ID bit manipulation for prefix-pruning queries on a base-
 *  resolution table.
 *
 *  H3 v4 cell ID layout (64 bits, MSB→LSB):
 *
 *    1 reserved | 4 mode | 3 reserved | 4 resolution | 7 base_cell | 45 digits
 *
 *  Where `digits` is 15 × 3-bit slots: digit[1]..digit[15]. For a cell at
 *  resolution N, digits[1..N] are real (values 0–6), digits[N+1..15] are
 *  the sentinel value 7.
 *
 *  Key property: for a uniform-resolution table at base B, sorting cells
 *  numerically sorts them by `(base_cell, digit_1, …, digit_B)` — the
 *  high-order non-digit bits are identical. The set of base-resolution
 *  descendants of any ancestor cell C at resolution N (N < B) shares
 *  digits[1..N] with C, so they form a contiguous numerical range —
 *  exploitable as a parquet row-group pruning filter on `h3_r{B}`.
 *
 *  This file builds those ranges. Tested against `h3-js` `cellToParent`
 *  to verify the bit layout assumptions hold (see `h3-range.test.ts`).
 */

/** A single contiguous range `[lo, hi]` of base-res cell IDs covering all
 *  base-res descendants of a single ancestor cell. Both bounds inclusive.
 *  Stored as `bigint` because cell IDs use 64 bits (top bit always 0 for
 *  cells, so they fit in int64 too — but bigint is unambiguous). */
export type CellRange = { lo: bigint; hi: bigint }

const RES_SHIFT = 52n
const RES_MASK = 0xfn << RES_SHIFT
const DIGIT_MASK_3BIT = 0x7n
const DIGIT_BITS = 3n

/** Total digit bits = 45 (digits 1..15). The lowest 3 bits = digit 15. */
function digitShift(d: number): bigint {
    if (d < 1 || d > 15) throw new Error(`bad digit index ${d}`)
    return BigInt((15 - d) * 3)
}

/** Replace the resolution nibble with `res`. */
function setResolution(cell: bigint, res: number): bigint {
    if (res < 0 || res > 15) throw new Error(`bad resolution ${res}`)
    return (cell & ~RES_MASK) | (BigInt(res) << RES_SHIFT)
}

/** Set digits[d..15] all to `value` (3 bits each). `value` must fit in 3
 *  bits (0–7). */
function setDigitsFrom(cell: bigint, dStart: number, value: number): bigint {
    if (dStart < 1 || dStart > 16) throw new Error(`bad start digit ${dStart}`)
    if (value < 0 || value > 7) throw new Error(`bad digit value ${value}`)
    let out = cell
    const v = BigInt(value)
    for (let d = dStart; d <= 15; d++) {
        const shift = digitShift(d)
        out = (out & ~(DIGIT_MASK_3BIT << shift)) | (v << shift)
    }
    return out
}

/** Compute the inclusive [min, max] range of base-resolution cell IDs
 *  covering all descendants of `ancestor` (which is at resolution
 *  `ancestorRes`).
 *
 *  - `min`: keep digits[1..ancestorRes], set digits[ancestorRes+1..base]=0,
 *    digits[base+1..15]=7 (sentinel for unused slots), resolution=base.
 *  - `max`: keep digits[1..ancestorRes], set digits[ancestorRes+1..base]=6
 *    (highest valid digit), digits[base+1..15]=7, resolution=base.
 *
 *  Pentagon caveat: for pentagon cells the digit values 0–5 are valid
 *  (digit 6 is "deleted"), but for the purposes of a numerical range
 *  filter on a sorted table, including digit 6 in [min,max] is fine —
 *  any actual cell with that digit doesn't exist, so the row-group
 *  pruning may be slightly looser but never excludes valid rows. */
export function descendantRange(
    ancestor: bigint,
    ancestorRes: number,
    baseRes: number,
): CellRange {
    if (ancestorRes < 0 || ancestorRes > baseRes) {
        throw new Error(`ancestorRes ${ancestorRes} must be in [0, ${baseRes}]`)
    }
    if (ancestorRes === baseRes) {
        // Single-cell range.
        return { lo: ancestor, hi: ancestor }
    }
    // Start by stamping resolution=baseRes onto the ancestor; the digits
    // beyond ancestorRes still carry the ancestor's sentinel 7s, which we
    // overwrite next.
    const stamped = setResolution(ancestor, baseRes)
    // For min: zero-fill digits[ancestorRes+1..baseRes], leave [baseRes+1..15]=7.
    let lo = stamped
    for (let d = ancestorRes + 1; d <= baseRes; d++) {
        const shift = digitShift(d)
        lo = lo & ~(DIGIT_MASK_3BIT << shift)
    }
    // Re-set the sentinel tail [baseRes+1..15]=7 (already 7 from ancestor,
    // but be explicit so this works for any input).
    if (baseRes < 15) lo = setDigitsFrom(lo, baseRes + 1, 7)
    // For max: same as ancestor with res=baseRes — digits[ancestorRes+1..15]
    // are all 7 (sentinel), which is numerically the largest possible. But
    // a valid base-res cell has digits[1..baseRes] in [0..6], so to get a
    // tighter (and still-correct) max, fill [ancestorRes+1..baseRes] with 6.
    let hi = stamped
    for (let d = ancestorRes + 1; d <= baseRes; d++) {
        const shift = digitShift(d)
        hi = (hi & ~(DIGIT_MASK_3BIT << shift)) | (BigInt(6) << shift)
    }
    if (baseRes < 15) hi = setDigitsFrom(hi, baseRes + 1, 7)
    return { lo, hi }
}

/** Compute descendant ranges for a set of ancestor cells, then merge
 *  any that are adjacent or overlapping. Output is sorted by `lo`.
 *
 *  Adjacency check: `a.hi + 1 >= b.lo`. We *can* merge ranges that aren't
 *  literally adjacent (gaps will simply read extra row groups), but
 *  parquet RG pruning works best with non-overlapping disjoint ranges, so
 *  prefer minimal merging. */
export function mergeRanges(ranges: CellRange[]): CellRange[] {
    if (ranges.length === 0) return []
    const sorted = [...ranges].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0))
    const out: CellRange[] = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
        const top = out[out.length - 1]
        const next = sorted[i]
        if (next.lo <= top.hi + 1n) {
            if (next.hi > top.hi) top.hi = next.hi
        } else {
            out.push(next)
        }
    }
    return out
}

/** Build the merged base-res descendant ranges for a set of ancestor
 *  cells (the h3 covering of a viewport). Ready to plug into a parquet
 *  row-group filter. */
export function rangesForCovering(
    ancestors: bigint[],
    ancestorRes: number,
    baseRes: number,
): CellRange[] {
    return mergeRanges(ancestors.map(a => descendantRange(a, ancestorRes, baseRes)))
}
