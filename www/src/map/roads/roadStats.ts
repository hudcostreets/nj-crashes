/** Per-period aggregates of a road's crashes, for the road page's plots and `RoadPanel`'s strip. */
import type { RoadCrash } from "./roadsData"

export type SevCounts = { f: number[]; i: number[]; p: number[] }

export type YearStats = SevCounts & {
    years: number[]
    killed: number[]
    injured: number[]
}

export type MonthStats = SevCounts & {
    /** `YYYY-MM` */
    months: string[]
}

function isSev(s: string): s is "f" | "i" | "p" {
    return s === "f" || s === "i" || s === "p"
}

/** Crashes by severity, plus killed / injured totals, per year over `[y0, y1]` (widened to cover
 *  every crash's year; years without crashes are zeros). */
export function yearStats(crashes: Pick<RoadCrash, "year" | "severity" | "tk" | "ti">[], y0: number, y1: number): YearStats {
    for (const c of crashes) {
        if (c.year < y0) y0 = c.year
        if (c.year > y1) y1 = c.year
    }
    const n = Math.max(0, y1 - y0 + 1)
    const zeros = () => new Array<number>(n).fill(0)
    const out: YearStats = { years: Array.from({ length: n }, (_, i) => y0 + i), f: zeros(), i: zeros(), p: zeros(), killed: zeros(), injured: zeros() }
    for (const c of crashes) {
        const k = c.year - y0
        if (isSev(c.severity)) out[c.severity][k]++
        out.killed[k] += c.tk ?? 0
        out.injured[k] += c.ti ?? 0
    }
    return out
}

/** Crashes by severity per calendar month (`dt` is epoch ms of a naive local timestamp, so it's
 *  read in UTC) over `[y0, y1]`, widened like `yearStats`. */
export function monthStats(crashes: Pick<RoadCrash, "dt" | "severity">[], y0: number, y1: number): MonthStats {
    const ym = crashes.map(c => {
        const d = new Date(c.dt)
        return [d.getUTCFullYear(), d.getUTCMonth()] as const
    })
    for (const [y] of ym) {
        if (y < y0) y0 = y
        if (y > y1) y1 = y
    }
    const n = Math.max(0, (y1 - y0 + 1) * 12)
    const zeros = () => new Array<number>(n).fill(0)
    const months = Array.from({ length: n }, (_, k) => `${y0 + Math.floor(k / 12)}-${String(k % 12 + 1).padStart(2, "0")}`)
    const out: MonthStats = { months, f: zeros(), i: zeros(), p: zeros() }
    crashes.forEach((c, j) => {
        const [y, m] = ym[j]
        if (isSev(c.severity)) out[c.severity][(y - y0) * 12 + m]++
    })
    return out
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
