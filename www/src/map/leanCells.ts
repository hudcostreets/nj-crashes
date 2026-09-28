/** "Lean" cells fetch for the non-pickable density renders (Heatmap mode):
 *  just the four severity counts, no labels / `fatal_years` / `n_vehs`, and —
 *  when the worker supports it — one response per viewport carrying *every*
 *  year and severity, so year-range and severity changes re-aggregate
 *  locally instead of re-fetching (`specs/map-mobile-perf.md`).
 *
 *  Three wire shapes decode to the same `LeanTable`:
 *  - `format=cols&group=year` (worker capability `group_year`): per-(cell,
 *    year) rows over the full year range + all severities.
 *  - `format=cols` (no `group`): per-cell counts for the requested years /
 *    severities (a worker without `group_year`).
 *  - rows (`cells: [...]`): a worker predating `format=cols` ignores it.
 *  The latter two are already filtered server-side (`byYear: false`). */
import type { StackedCell } from "./StackedCellLayer"
import { decodeTokens, HEAT_FIELDS } from "./cellsCols"
import { tokenCenterLngLat } from "./s2"

export type Severity = "f" | "i" | "p"

/** Column-oriented, decode-once view of a lean response. Row `r` belongs to
 *  cell `c` for `offsets[c] <= r < offsets[c + 1]`. */
export type LeanTable = {
    res: number
    source: "pyramid" | "d1"
    /** `true` ⇒ rows are per (cell, year) over all severities, and the
     *  caller's year / severity filter is applied at aggregation time.
     *  `false` ⇒ one row per cell, already filtered by the worker. */
    byYear: boolean
    ids: string[]
    /** Cell centers, `[lng, lat]` interleaved (`2 × ids.length`). */
    centers: Float64Array
    offsets: Uint32Array
    year: Uint16Array
    fatal: Uint32Array
    pedInj: Uint32Array
    otherInj: Uint32Array
    pdo: Uint32Array
}

type ColsBody = {
    format: "cols"
    group?: "year"
    cellid_enc: "prefix-hex1"
    res: number
    source: "pyramid" | "d1"
    n: number
    cols: { cellid: string[]; nyears?: number[]; year?: number[] } & Partial<Record<typeof HEAT_FIELDS[number], number[]>>
}
type RowsBody = {
    format?: undefined
    res: number
    source: "pyramid" | "d1"
    cells: Array<{ cellid: string; n_fatal: number; n_inj_ped: number; n_inj_other: number; n_pdo: number }>
}
export type LeanBody = ColsBody | RowsBody

/** Query params for a lean request (everything but `cells`, `res`,
 *  `shard_res`, `polygon`, `maxCells`, which the caller already sets).
 *
 *  With `groupYear` and a year *sub*-range, the params are independent of
 *  the user's year / severity filter — that's what makes a filter change a
 *  cache hit. A filter covering every year keeps the plain all-years
 *  request instead: the worker serves that from its D1 rollup, which is
 *  faster than the per-year pyramid read, and it's the default view. */
export function leanParams(
    groupYear: boolean,
    yearRange: [number, number],
    fullYears: [number, number],
    severities: Set<Severity>,
): Record<string, string> {
    const base = { labels: "nums", format: "cols", fields: HEAT_FIELDS.join(",") }
    const subRange = yearRange[0] > fullYears[0] || yearRange[1] < fullYears[1]
    if (groupYear && subRange) return { ...base, years: `${fullYears[0]}-${fullYears[1]}`, severities: "fip", group: "year" }
    const sevs = (["f", "i", "p"] as const).filter(s => severities.has(s)).join("")
    return { ...base, years: `${yearRange[0]}-${yearRange[1]}`, severities: sevs }
}

/** Decode any of the three lean wire shapes (see module doc). */
export function decodeLean(body: LeanBody, centerOf: (token: string) => [number, number] = tokenCenterLngLat): LeanTable {
    let ids: string[]
    let nyears: number[] | null = null
    let year: number[] | null = null
    let cols: Record<typeof HEAT_FIELDS[number], number[]>
    if (body.format === "cols") {
        if (body.cellid_enc !== "prefix-hex1") throw new Error(`unknown cellid_enc '${body.cellid_enc}'`)
        ids = decodeTokens(body.cols.cellid)
        const col = (f: typeof HEAT_FIELDS[number]) => {
            const c = body.cols[f]
            if (!c) throw new Error(`cells cols: '${f}' missing`)
            return c
        }
        cols = { n_fatal: col("n_fatal"), n_inj_ped: col("n_inj_ped"), n_inj_other: col("n_inj_other"), n_pdo: col("n_pdo") }
        if (body.group === "year") {
            nyears = body.cols.nyears ?? null
            year = body.cols.year ?? null
            if (!nyears || !year || nyears.length !== ids.length) throw new Error("cells group=year: nyears/year missing or misaligned")
        }
    } else {
        ids = body.cells.map(c => c.cellid)
        cols = {
            n_fatal: body.cells.map(c => c.n_fatal),
            n_inj_ped: body.cells.map(c => c.n_inj_ped),
            n_inj_other: body.cells.map(c => c.n_inj_other),
            n_pdo: body.cells.map(c => c.n_pdo),
        }
    }
    const nRows = year ? year.length : ids.length
    for (const f of HEAT_FIELDS) {
        if (cols[f].length !== nRows) throw new Error(`cells: '${f}' has ${cols[f].length} rows, expected ${nRows}`)
    }
    const offsets = new Uint32Array(ids.length + 1)
    for (let i = 0; i < ids.length; i++) offsets[i + 1] = offsets[i] + (nyears ? nyears[i] : 1)
    if (offsets[ids.length] !== nRows) throw new Error(`cells: nyears sums to ${offsets[ids.length]}, expected ${nRows}`)
    const centers = new Float64Array(ids.length * 2)
    for (let i = 0; i < ids.length; i++) {
        const [lng, lat] = centerOf(ids[i])
        centers[2 * i] = lng
        centers[2 * i + 1] = lat
    }
    return {
        res: body.res, source: body.source, byYear: !!year, ids, centers, offsets,
        year: Uint16Array.from(year ?? []),
        fatal: Uint32Array.from(cols.n_fatal),
        pedInj: Uint32Array.from(cols.n_inj_ped),
        otherInj: Uint32Array.from(cols.n_inj_other),
        pdo: Uint32Array.from(cols.n_pdo),
    }
}

/** `LeanTable` → `StackedCell[]` for a year range + severity set. For a
 *  `byYear` table this is where the filter is applied (a filter change costs
 *  one pass over the rows, no request); otherwise the rows are taken as-is.
 *  Cells with no crash of a selected severity are dropped (as the worker
 *  does). */
export function aggregateLean(t: LeanTable, yearRange: [number, number], severities: Set<Severity>): StackedCell[] {
    const wantF = !t.byYear || severities.has("f")
    const wantI = !t.byYear || severities.has("i")
    const wantP = !t.byYear || severities.has("p")
    const [y0, y1] = yearRange
    const out: StackedCell[] = []
    for (let c = 0; c < t.ids.length; c++) {
        let fatal = 0, pedInj = 0, otherInj = 0, pdo = 0
        for (let r = t.offsets[c]; r < t.offsets[c + 1]; r++) {
            if (t.byYear && (t.year[r] < y0 || t.year[r] > y1)) continue
            if (wantF) fatal += t.fatal[r]
            if (wantI) { pedInj += t.pedInj[r]; otherInj += t.otherInj[r] }
            if (wantP) pdo += t.pdo[r]
        }
        const total = fatal + pedInj + otherInj + pdo
        if (total === 0) continue
        out.push({
            cellid: t.ids[c],
            center: [t.centers[2 * c], t.centers[2 * c + 1]],
            fatal, pedInj, otherInj, pdo, total,
        })
    }
    return out
}
