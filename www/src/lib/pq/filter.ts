/** Row filters: matched against rows with SQL null semantics, and against row groups' column
 *  statistics to skip groups that can't match (equality, ranges, `IN` lists, `IS [NOT] NULL`, `OR`s). */
import type { ColumnChunk, RowGroup } from "hyparquet"

export type Scalar = number | string | boolean

/** Conditions on one column (all must hold). Comparisons with null are false (SQL), so only `$null`
 *  matches nulls. */
export type Cond = {
    $eq?: Scalar
    $ne?: Scalar
    $in?: readonly Scalar[]
    $gt?: Scalar
    $gte?: Scalar
    $lt?: Scalar
    $lte?: Scalar
    /** true: IS NULL; false: IS NOT NULL. */
    $null?: boolean
}

/** `{ col: value }` is equality (`{ col: null }`: IS NULL), `{ col: Cond }`; several keys AND;
 *  `$and` / `$or` nest. */
export type Filter = {
    $and?: readonly Filter[]
    $or?: readonly Filter[]
    [col: string]: Scalar | null | Cond | readonly Filter[] | undefined
}

type Row = Record<string, unknown>

function asCond(c: Scalar | null | Cond): Cond {
    if (c === null) return { $null: true }
    if (typeof c === "object") return c
    return { $eq: c }
}

function entries(f: Filter): [string, Scalar | null | Cond | readonly Filter[]][] {
    return Object.entries(f).filter((e): e is [string, Scalar | null | Cond | readonly Filter[]] => e[1] !== undefined)
}

export function matchCond(v: unknown, cond: Cond): boolean {
    const isNull = v === null || v === undefined
    if (cond.$null !== undefined && cond.$null !== isNull) return false
    const ops = (["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte"] as const).filter(k => cond[k] !== undefined)
    if (!ops.length) return true
    if (isNull) return false
    const x = v as Scalar
    for (const op of ops) {
        const t = cond[op]!
        if (op === "$eq" && x !== t) return false
        if (op === "$ne" && x === t) return false
        if (op === "$in" && !(t as readonly Scalar[]).includes(x)) return false
        if (op === "$gt" && !(x > (t as Scalar))) return false
        if (op === "$gte" && !(x >= (t as Scalar))) return false
        if (op === "$lt" && !(x < (t as Scalar))) return false
        if (op === "$lte" && !(x <= (t as Scalar))) return false
    }
    return true
}

export function matchFilter(row: Row, f: Filter): boolean {
    for (const [k, c] of entries(f)) {
        if (k === "$and") { if (!(c as readonly Filter[]).every(g => matchFilter(row, g))) return false; continue }
        if (k === "$or") { if (!(c as readonly Filter[]).some(g => matchFilter(row, g))) return false; continue }
        if (!matchCond(row[k], asCond(c as Scalar | null | Cond))) return false
    }
    return true
}

/** Columns a filter reads. */
export function filterColumns(f: Filter | undefined, out = new Set<string>()): Set<string> {
    if (!f) return out
    for (const [k, c] of entries(f)) {
        if (k === "$and" || k === "$or") for (const g of c as readonly Filter[]) filterColumns(g, out)
        else out.add(k)
    }
    return out
}

/** A column chunk's statistics, normalized (`bigint` → number, `Date` → epoch ms). */
export type ColStats = { min?: Scalar; max?: Scalar; nullCount?: number; numRows: number }

export function normalizeValue(v: unknown): unknown {
    if (typeof v === "bigint") return Number(v)
    if (v instanceof Date) return v.getTime()
    return v
}

export function chunkStats(chunk: ColumnChunk, numRows: number): ColStats | null {
    const md = chunk.meta_data
    const s = md?.statistics
    if (!md || !s) return null
    // The deprecated `min` / `max` of byte arrays use signed-byte order; only trust `*_value` there.
    const bytes = md.type === "BYTE_ARRAY" || md.type === "FIXED_LEN_BYTE_ARRAY"
    const lo = normalizeValue(s.min_value ?? (bytes ? undefined : s.min))
    const hi = normalizeValue(s.max_value ?? (bytes ? undefined : s.max))
    const ok = (v: unknown): v is Scalar => (typeof v === "number" && !Number.isNaN(v)) || typeof v === "string" || typeof v === "boolean"
    return {
        min: ok(lo) ? lo : undefined,
        max: ok(hi) ? hi : undefined,
        nullCount: s.null_count === undefined ? undefined : Number(s.null_count),
        numRows,
    }
}

/** Whether no row with these column stats can satisfy `cond`. */
export function condSkips(st: ColStats | null | undefined, cond: Cond): boolean {
    if (!st) return false
    const allNull = st.nullCount !== undefined && st.nullCount === st.numRows
    if (cond.$null === true && st.nullCount === 0) return true
    if (cond.$null === false && allNull) return true
    const ops = (["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte"] as const).filter(k => cond[k] !== undefined)
    if (!ops.length) return false
    if (allNull) return true
    const { min, max } = st
    if (min === undefined || max === undefined) return false
    for (const op of ops) {
        const t = cond[op]!
        if (op === "$eq" && (t < min || t > max)) return true
        if (op === "$ne" && min === max && min === t) return true
        if (op === "$in" && (t as readonly Scalar[]).every(x => x < min || x > max)) return true
        if (op === "$gt" && max <= (t as Scalar)) return true
        if (op === "$gte" && max < (t as Scalar)) return true
        if (op === "$lt" && min >= (t as Scalar)) return true
        if (op === "$lte" && min > (t as Scalar)) return true
    }
    return false
}

/** Whether no row of `group` can satisfy `f` (by its columns' statistics; `columns[i]` names
 *  `group.columns[i]`). */
export function groupSkips(f: Filter | undefined, group: RowGroup, columns: readonly string[]): boolean {
    if (!f) return false
    const numRows = Number(group.num_rows)
    const stats = (col: string) => {
        const i = columns.indexOf(col)
        return i < 0 ? null : chunkStats(group.columns[i], numRows)
    }
    const skips = (g: Filter): boolean => entries(g).some(([k, c]) => {
        if (k === "$and") return (c as readonly Filter[]).some(skips)
        if (k === "$or") return (c as readonly Filter[]).every(skips)
        return condSkips(stats(k), asCond(c as Scalar | null | Cond))
    })
    return skips(f)
}
