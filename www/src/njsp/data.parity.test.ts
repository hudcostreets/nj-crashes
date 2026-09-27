/** Parity: the NJSP plot selectors (`data.ts`) over `readRows` return what the DuckDB SQL they
 *  replaced did, on the real `public/njsp` files, statewide / per county / per muni. Needs those
 *  files (`dvx pull`) and the `duckdb` CLI; skipped without them. */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { openParquet, readRows } from "@/src/lib/pq"
import { duckRows as duckRowsF, fileRangeFetch, haveDuckdb, type Row } from "@/src/lib/pq/nodeFetch"
import { CrashHomicideParquet, MonthlyParquet, YtcParquet, YtdParquet } from "@/src/paths"
import {
    crashHomicideAt, monthlyAtGeo, parseCsv, projectionTotals, yearlyFromMonthly, ytcYearly, ytdAtGeo,
    type CrashHomicideFileRow, type Geo, type MonthlyFileRow, type ProjectedRow, type YtcFileRow, type YtdFileRow,
} from "./data"
import type { VictimType } from "./victim-types"

/** These files have DOUBLEs only: compare exactly. */
const duckRows = (sql: string) => duckRowsF(sql, { fround: false })

const PUBLIC = join(__dirname, "../../public")
const PATHS = [MonthlyParquet, YtdParquet, YtcParquet, CrashHomicideParquet]
const enabled = haveDuckdb && PATHS.every(p => existsSync(join(PUBLIC, p)))

const f = (p: string) => `'${join(PUBLIC, p)}'`
const whereGeo = ({ county, cc, mc }: Geo) =>
    cc !== null && mc !== null ? `cc = ${cc} AND mc = ${mc}` : county ? `county = '${county}' AND mc IS NULL` : `county IS NULL AND cc IS NULL`

describe.skipIf(!enabled)("NJSP plot data: pq vs DuckDB", () => {
    let monthly: MonthlyFileRow[], ytd: YtdFileRow[], ytc: YtcFileRow[], ch: CrashHomicideFileRow[]
    let geos: Geo[]
    beforeAll(async () => {
        for (const p of PATHS) await openParquet(p, { fetch: fileRangeFetch(join(PUBLIC, p)) })
        monthly = await readRows<MonthlyFileRow>(MonthlyParquet)
        ytd = await readRows<YtdFileRow>(YtdParquet)
        ytc = await readRows<YtcFileRow>(YtcParquet)
        ch = await readRows<CrashHomicideFileRow>(CrashHomicideParquet)
        const muni = duckRows(`SELECT cc, mc, county FROM ${f(MonthlyParquet)} WHERE mc IS NOT NULL GROUP BY ALL ORDER BY sum(fatalities) DESC LIMIT 1`)[0]
        geos = [
            { county: null, cc: null, mc: null },
            { county: "Hudson", cc: null, mc: null },
            { county: muni.county as string, cc: muni.cc as number, mc: muni.mc as number },
        ]
    })

    it("monthly rows at a geo, by date", () => {
        for (const geo of geos) {
            const want = duckRows(`SELECT date, year, month, fatalities, driver, passenger, pedestrian, cyclist, avg_12mo FROM ${f(MonthlyParquet)} WHERE ${whereGeo(geo)} ORDER BY date`)
            // The CLI prints timestamps as text; `runQuery` returned epoch ms.
            const got = monthlyAtGeo(monthly, geo).map(({ date, year, month, fatalities, driver, passenger, pedestrian, cyclist, avg_12mo }) =>
                ({ date: new Date(date).toISOString().replace("T", " ").replace(".000Z", ""), year, month, fatalities, driver, passenger, pedestrian, cyclist, avg_12mo }))
            expect(got).toEqual(want)
            expect(want.length > 12).toBe(true)
        }
    })

    it("yearly sums from monthly", () => {
        for (const geo of geos) {
            const want = duckRows(`SELECT year, CAST(SUM(driver) as INT) as driver, CAST(SUM(pedestrian) as INT) as pedestrian, CAST(SUM(cyclist) as INT) as cyclist,
                CAST(SUM(passenger) as INT) as passenger, CAST(SUM(fatalities) as INT) as total FROM ${f(MonthlyParquet)} WHERE ${whereGeo(geo)} GROUP BY year ORDER BY year`)
            expect(yearlyFromMonthly(monthly, geo)).toEqual(want)
        }
    })

    it("ytc yearly sums (statewide, county)", () => {
        for (const county of [null, "Hudson"]) {
            const want = duckRows(`SELECT year, CAST(sum(driver) as INT) as driver, CAST(sum(pedestrian) as INT) as pedestrian, CAST(sum(cyclist) as INT) as cyclist,
                CAST(sum(passenger) as INT) as passenger, CAST(sum(driver + pedestrian + cyclist + passenger) as INT) as total
                FROM ${f(YtcParquet)} ${county ? `WHERE county = '${county}'` : ""} GROUP BY year ORDER BY year`)
            expect(ytcYearly(ytc, county)).toEqual(want)
        }
    })

    it("ytd rows: all types, and a type subset", () => {
        const subsets: VictimType[][] = [["driver", "passenger", "pedestrian", "cyclist"], ["pedestrian", "cyclist"]]
        for (const geo of geos) {
            for (const types of subsets) {
                const all = types.length === 4
                const fat = all ? "fatalities" : types.join(" + ")
                const cum = all ? "cumulative" : types.map(t => `${t}_cumulative`).join(" + ")
                const want = duckRows(`SELECT year, day_of_year, date_label, (${fat}) AS fatalities, (${cum}) AS cumulative FROM ${f(YtdParquet)} WHERE ${whereGeo(geo)} ORDER BY year, day_of_year`)
                expect(ytdAtGeo(ytd, geo, types)).toEqual(want)
            }
        }
    })

    it("crash-homicide rows", () => {
        for (const [county, source] of [[null, "njsp"], [null, "njdot"], ["Hudson", "njsp"]] as const) {
            const want = duckRows(`SELECT year, traffic_deaths, homicides, ratio FROM ${f(CrashHomicideParquet)} WHERE source = '${source}'
                AND (${county ? `county = '${county}'` : `county IS NULL OR county = ''`}) ORDER BY year`)
            expect(crashHomicideAt(ch, county, source)).toEqual(want)
            expect(want.length > 10).toBe(true)
        }
    })

    it("projection totals from projected.csv", () => {
        const csv = join(PUBLIC, "njsp/projected.csv")
        const rows = parseCsv(readFileSync(csv, "utf8")) as unknown as ProjectedRow[]
        const cols = ["driver", "pedestrian", "cyclist", "passenger", "trailing_365_driver", "trailing_365_pedestrian", "trailing_365_cyclist", "trailing_365_passenger"]
        const muni = rows.find(r => r.mc !== null)!
        const geos: Geo[] = [{ county: null, cc: null, mc: null }, { county: "Hudson", cc: null, mc: null }, { county: null, cc: muni.cc, mc: muni.mc }]
        for (const geo of geos) {
            const [want] = duckRows(`SELECT ${cols.map(c => `CAST(sum(${c}) as INT) as ${c}`).join(", ")} FROM read_csv_auto('${csv}') ${
                geo.cc !== null ? `WHERE cc = ${geo.cc} AND mc = ${geo.mc}` : geo.county ? `WHERE county = '${geo.county}' AND mc IS NULL` : "WHERE mc IS NULL"}`) as Row[]
            expect(projectionTotals(rows, geo)).toEqual(want)
        }
    })
})
