/** Decoder for the D1 rollup's `by_year` column: a cell's per-year counts,
 *  packed as TEXT (encoder + grammar: `njdot/cells_years.py`; design:
 *  `specs/cells-d1-years.md`).
 *
 *      by_year := entry (';' entry)*     ascending year, one per year with ≥1 crash
 *      entry   := YY ':' c0 (',' c)*     YY = year - BY_YEAR_BASE
 *      c       := '' | [1-9][0-9]*       empty = 0; trailing zero counts dropped
 *
 *  e.g. `13:3,1,2,1;19:1,,,,1,1,1`. Parsed straight off char codes — no
 *  `split`, no allocation per entry — since a wide view decodes ~10⁵ cells. */
import type { CountField } from "./cells"

export const BY_YEAR_BASE = 2000

/** Count order within an entry (most-often-nonzero first). */
export const BY_YEAR_FIELDS = [
    "n_vehs", "n_pdo", "n_inj_other", "n_inj_ped", "n_fatal", "n_killed", "n_killed_ped",
] as const satisfies readonly CountField[]

export const N_BY_YEAR = BY_YEAR_FIELDS.length

/** Index of each field in an entry's counts. */
export const BY_YEAR_IDX = Object.fromEntries(BY_YEAR_FIELDS.map((f, i) => [f, i])) as Record<CountField, number>

const SEMI = 59, COLON = 58, COMMA = 44, ZERO = 48, NINE = 57

function malformed(enc: string, at: number): Error {
    return new Error(`malformed by_year at ${at}: ${JSON.stringify(enc)}`)
}

/** Call `cb(year, counts)` for each entry, in order. `counts` is one reused
 *  `N_BY_YEAR`-long buffer (in `BY_YEAR_FIELDS` order) — copy it to keep it. */
export function forEachYear(enc: string, cb: (year: number, counts: Int32Array) => void): void {
    const counts = new Int32Array(N_BY_YEAR)
    const n = enc.length
    let i = 0
    while (i < n) {
        let yy = 0
        const y0 = i
        let c = enc.charCodeAt(i)
        while (c >= ZERO && c <= NINE) { yy = yy * 10 + c - ZERO; c = enc.charCodeAt(++i) }
        if (i === y0 || c !== COLON) throw malformed(enc, i)
        i++
        counts.fill(0)
        let k = 0, v = 0
        for (; i < n; i++) {
            c = enc.charCodeAt(i)
            if (c >= ZERO && c <= NINE) v = v * 10 + c - ZERO
            else if (c === COMMA) {
                if (k >= N_BY_YEAR - 1) throw malformed(enc, i)
                counts[k++] = v; v = 0
            }
            else if (c === SEMI) break
            else throw malformed(enc, i)
        }
        counts[k] = v
        cb(BY_YEAR_BASE + yy, counts)
        if (i < n) {
            i++  // past ';'
            if (i === n) throw malformed(enc, i)
        }
    }
}

/** Sum the entries with `y0 <= year <= y1` into `out` (`BY_YEAR_FIELDS`
 *  order; zeroed first). Returns the in-range years with ≥1 fatal crash,
 *  ascending (empty when none). */
export function sumByYear(enc: string, y0: number, y1: number, out: Int32Array): number[] {
    out.fill(0)
    const fatalYears: number[] = []
    const iFatal = BY_YEAR_IDX.n_fatal
    forEachYear(enc, (year, counts) => {
        if (year < y0 || year > y1) return
        for (let k = 0; k < N_BY_YEAR; k++) out[k] += counts[k]
        if (counts[iFatal] > 0) fatalYears.push(year)
    })
    return fatalYears
}
