import { loadJson } from "@rdub/base/json/load";
import { join } from "path";
import { PLOTS, ProjectedCsv, RUNDATE, YearTypeCountyCsv } from "@/server/paths";
import { njspPlotSpec } from "@/src/plotSpecs";
import { Database } from "duckdb-async";
import { OPEN_READWRITE } from "duckdb";
import { PlotParams, Props, TypeCounts, YtRow } from "@/src/njsp/plot";
import { Counties } from "../county";

export const typeCountsQuery = (county: string | null) => `
    SELECT
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger
    FROM read_csv_auto('${ProjectedCsv}')
    ${county ? `WHERE county = '${county}'` : ``}
`

export const ytcQuery = (county: string | null) => `
    SELECT
        CAST(year as INT) as year,
        CAST(sum(driver) as INT) as driver,
        CAST(sum(pedestrian) as INT) as pedestrian,
        CAST(sum(cyclist) as INT) as cyclist,
        CAST(sum(passenger) as INT) as passenger,
        CAST(sum(driver + pedestrian + cyclist + passenger) as INT) as total,
        NULL as projected
    FROM read_csv_auto('${YearTypeCountyCsv}')
    ${county ? `WHERE county = '${county}'` : ``}
    GROUP BY year
    ORDER BY year
`

export async function loadProps({ county, }: { county: string | null }): Promise<Props> {
  const initialPlotP = loadJson<PlotParams>(join(PLOTS, `${njspPlotSpec.name}.json`))
  const rundateP = loadJson<{ rundate: string }>(RUNDATE).then(o => o.rundate as string)
  const ddb = Database.create(':memory:', OPEN_READWRITE)
  const typeProjectionsP =
    ddb
      .then(ddb => ddb.all(typeCountsQuery(county)))
      .then(rows => rows[0] as TypeCounts)
  const ytRowsP =
    ddb.then(ddb =>
      ddb.all(ytcQuery(county)) as Promise<YtRow[]>
    )
  const [ initialPlot, rundate, ytRows, typeProjections, ] = await Promise.all([ initialPlotP, rundateP, ytRowsP, typeProjectionsP, ])
  // console.log(`rundate: ${rundate}`, "ytRows:", ytRows)
  return {
    initialPlot,
    typeProjections,
    ytRows,
    rundate,
    county,
    Counties,
  }
}

