/** Per-period aggregates of a road's crashes, for the road page's plots and `RoadPanel`'s strip,
 *  from `road-summary[-monthly]` rows (zero-filled: only non-zero cells have rows). */
import type { RoadSummaryRow } from "./roadsData"

export type SevCounts = { f: number[]; i: number[]; p: number[] }

export type YearStats = SevCounts & {
    years: number[]
    killed: number[]
    injured: number[]
    /** Of each severity's crashes, those located by street name / route only (no map point). */
    unplaced: SevCounts
}

export type MonthStats = SevCounts & {
    /** `YYYY-MM` */
    months: string[]
    unplaced: SevCounts
}

type Row = Pick<RoadSummaryRow, "year" | "severity" | "n" | "n_unplaced">

function isSev(s: string): s is "f" | "i" | "p" {
    return s === "f" || s === "i" || s === "p"
}

/** Crashes by severity, plus killed / injured totals, per year over `[y0, y1]` (widened to cover
 *  every row's year; years without rows are zeros). Monthly rows sum into their year. */
export function yearStats(rows: (Row & Pick<RoadSummaryRow, "tk" | "ti">)[], y0: number, y1: number): YearStats {
    for (const r of rows) {
        if (r.year < y0) y0 = r.year
        if (r.year > y1) y1 = r.year
    }
    const n = Math.max(0, y1 - y0 + 1)
    const zeros = () => new Array<number>(n).fill(0)
    const out: YearStats = {
        years: Array.from({ length: n }, (_, i) => y0 + i), f: zeros(), i: zeros(), p: zeros(), killed: zeros(), injured: zeros(),
        unplaced: { f: zeros(), i: zeros(), p: zeros() },
    }
    for (const r of rows) {
        const k = r.year - y0
        if (isSev(r.severity)) {
            out[r.severity][k] += r.n
            out.unplaced[r.severity][k] += r.n_unplaced ?? 0
        }
        out.killed[k] += r.tk
        out.injured[k] += r.ti
    }
    return out
}

/** Crashes by severity per calendar month over `[y0, y1]`, widened like `yearStats`. */
export function monthStats(rows: (Row & { month: number })[], y0: number, y1: number): MonthStats {
    for (const r of rows) {
        if (r.year < y0) y0 = r.year
        if (r.year > y1) y1 = r.year
    }
    const n = Math.max(0, (y1 - y0 + 1) * 12)
    const zeros = () => new Array<number>(n).fill(0)
    const months = Array.from({ length: n }, (_, k) => `${y0 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, "0")}`)
    const out: MonthStats = { months, f: zeros(), i: zeros(), p: zeros(), unplaced: { f: zeros(), i: zeros(), p: zeros() } }
    for (const r of rows) {
        if (!isSev(r.severity)) continue
        const k = (r.year - y0) * 12 + r.month - 1
        out[r.severity][k] += r.n
        out.unplaced[r.severity][k] += r.n_unplaced ?? 0
    }
    return out
}

/** Total crashes on the road located by street name / route only (no map point). */
export function unplacedTotal(rows: Pick<RoadSummaryRow, "n_unplaced">[]): number {
    return rows.reduce((sum, r) => sum + (r.n_unplaced ?? 0), 0)
}

/** Trailing `n`-point mean; null until a full window is available. */
export function rollingMean(ys: number[], n: number): (number | null)[] {
    const out: (number | null)[] = []
    let sum = 0
    for (let k = 0; k < ys.length; k++) {
        sum += ys[k]
        if (k >= n) sum -= ys[k - n]
        out.push(k >= n - 1 ? sum / n : null)
    }
    return out
}
