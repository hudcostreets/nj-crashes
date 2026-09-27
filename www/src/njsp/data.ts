/** NJSP plot data (`public/njsp/*.parquet`, `projected.csv`): each file is small (≤ 255 KB, one row
 *  group), so it's read whole once (`readRows`: one request, cached per session by react-query)
 *  and filtered / grouped here. Each selector mirrors the DuckDB SQL it replaced
 *  (specs/off-duckdb-wasm.md; parity: `data.parity.test.ts`). */
import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { groupSum, readRows, sortRows } from "@/src/lib/pq"
import { parseCsvLine } from "@/src/raw/csv"
import type { VictimType } from "./victim-types"

/** The geo filter the plots take: a muni (`cc` + `mc`), a county (by name), or statewide. */
export type Geo = { county: string | null; cc: number | null; mc: number | null }

type GeoRow = { county: string | null; cc: number | null; mc: number | null }

/** Rows of `monthly` / `ytd` at `geo`'s level: muni rows by `(cc, mc)`, county rows (`mc` null) by
 *  name, else the statewide rows (`county`, `cc` null). */
export function atGeo<T extends GeoRow>(rows: readonly T[], { county, cc, mc }: Geo): T[] {
    if (cc !== null && mc !== null) return rows.filter(r => r.cc === cc && r.mc === mc)
    if (county) return rows.filter(r => r.county === county && r.mc === null)
    return rows.filter(r => r.county === null && r.cc === null)
}

export type MonthlyFileRow = GeoRow & {
    date: number
    year: number
    month: number
    fatalities: number
    driver: number
    passenger: number
    pedestrian: number
    cyclist: number
    avg_12mo: number
}

export type YtdFileRow = GeoRow & {
    year: number
    day_of_year: number
    date_label: string
    fatalities: number
    cumulative: number
    driver: number
    passenger: number
    pedestrian: number
    cyclist: number
    driver_cumulative: number
    passenger_cumulative: number
    pedestrian_cumulative: number
    cyclist_cumulative: number
}

export type YtcFileRow = {
    year: number
    county: string
    driver: number
    passenger: number
    pedestrian: number
    cyclist: number
}

export type CrashHomicideFileRow = {
    source: string
    county: string | null
    year: number
    traffic_deaths: number
    homicides: number
    ratio: number
}

export type ProjectedRow = {
    cc: number | null
    mc: number | null
    county: string | null
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
    trailing_365_driver: number
    trailing_365_pedestrian: number
    trailing_365_cyclist: number
    trailing_365_passenger: number
}


/** A whole NJSP parquet file's rows (null until loaded). */
export function useNjspParquet<T>(url: string): { rows: T[] | null; loading: boolean } {
    const q = useQuery({ queryKey: ["njsp-parquet", url], queryFn: () => readRows<T>(url), staleTime: Infinity })
    if (q.error) console.error(`${url}:`, q.error)
    // Stable across renders (callers memoize on it).
    return useMemo(() => ({ rows: q.data ?? null, loading: q.isPending }), [q.data, q.isPending])
}

/** `projected.csv`: blank cells → null, numeric ones → numbers (like `read_csv_auto`). */
export function parseCsv(text: string): Record<string, string | number | null>[] {
    const [header, ...lines] = text.replace(/\r/g, "").split("\n").filter(l => l.length)
    const cols = parseCsvLine(header)
    return lines.map(line => {
        const vals = parseCsvLine(line)
        return Object.fromEntries(cols.map((c, i) => {
            const v = vals[i] ?? ""
            return [c, v === "" ? null : /^-?\d+(\.\d+)?$/.test(v) ? +v : v]
        }))
    })
}

export function useProjected(url: string): ProjectedRow[] | null {
    const q = useQuery({
        queryKey: ["njsp-csv", url],
        queryFn: async () => parseCsv(await fetch(url).then(r => r.text())) as unknown as ProjectedRow[],
        staleTime: Infinity,
    })
    return q.data ?? null
}

/** `SELECT … FROM monthly WHERE <geo> ORDER BY date` */
export function monthlyAtGeo(rows: readonly MonthlyFileRow[], geo: Geo): MonthlyFileRow[] {
    return sortRows(atGeo(rows, geo), ["date"])
}

/** `SELECT year, sum(driver), …, sum(fatalities) AS total FROM monthly WHERE <geo> GROUP BY year ORDER BY year` */
export function yearlyFromMonthly(rows: readonly MonthlyFileRow[], geo: Geo) {
    return groupSum(atGeo(rows, geo), ["year"], {
        driver: r => r.driver,
        pedestrian: r => r.pedestrian,
        cyclist: r => r.cyclist,
        passenger: r => r.passenger,
        total: r => r.fatalities,
    })
}

/** `SELECT year, sum(<types>)[, sum(all four) AS total] FROM ytc [WHERE county = ?] GROUP BY year ORDER BY year` */
export function ytcYearly(rows: readonly YtcFileRow[], county: string | null) {
    return groupSum(county ? rows.filter(r => r.county === county) : rows, ["year"], {
        driver: r => r.driver,
        pedestrian: r => r.pedestrian,
        cyclist: r => r.cyclist,
        passenger: r => r.passenger,
        total: r => r.driver + r.pedestrian + r.cyclist + r.passenger,
    })
}

/** The projection totals at `geo` (`projected.csv` sums: its muni rows by `(cc, mc)`, county rows by
 *  name, or all county rows for statewide). */
export function projectionTotals(rows: readonly ProjectedRow[], { county, cc, mc }: Geo) {
    const sel = cc !== null && mc !== null ? rows.filter(r => r.cc === cc && r.mc === mc)
        : county ? rows.filter(r => r.county === county && r.mc === null)
        : rows.filter(r => r.mc === null)
    const keys = [
        "driver", "pedestrian", "cyclist", "passenger",
        "trailing_365_driver", "trailing_365_pedestrian", "trailing_365_cyclist", "trailing_365_passenger",
    ] as const
    return Object.fromEntries(keys.map(k => [k, sel.reduce((s, r) => s + (r[k] ?? 0), 0)])) as Record<typeof keys[number], number>
}

/** `SELECT year, day_of_year, date_label, <fatalities>, <cumulative> FROM ytd WHERE <geo> ORDER BY
 *  year, day_of_year`: all four types → the precomputed totals, else the selected types' sums. */
export function ytdAtGeo(rows: readonly YtdFileRow[], geo: Geo, types: readonly VictimType[]) {
    const all = types.length === 4 || types.length === 0
    return sortRows(atGeo(rows, geo), ["year", "day_of_year"]).map(r => ({
        year: r.year,
        day_of_year: r.day_of_year,
        date_label: r.date_label,
        fatalities: all ? r.fatalities : types.reduce((s, t) => s + r[t], 0),
        cumulative: all ? r.cumulative : types.reduce((s, t) => s + r[`${t}_cumulative`], 0),
    }))
}

/** `SELECT year, traffic_deaths, homicides, ratio FROM crash_homicide WHERE source = ? AND
 *  <county, or statewide (null / '')> ORDER BY year` */
export function crashHomicideAt(rows: readonly CrashHomicideFileRow[], county: string | null, source: string) {
    return sortRows(
        rows.filter(r => r.source === source && (county ? r.county === county : r.county === null || r.county === "")),
        ["year"],
    ).map(({ year, traffic_deaths, homicides, ratio }) => ({ year, traffic_deaths, homicides, ratio }))
}

