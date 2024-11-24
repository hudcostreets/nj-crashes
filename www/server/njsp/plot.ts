import { njspPlotSpec, } from "@/src/plotSpecs";
import { PlotParams, Props, YtRow, } from "@/src/njsp/plot";
import { ProjectedCsv } from "@/src/paths";
import { getTypeProjections } from "./projections";
import { ytcQuery } from "@/src/njsp/ytc";
import { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";

export async function loadProps(
  { db, conn, county, Counties, }: {
      db: AsyncDuckDB
      conn: AsyncDuckDBConnection
      county: string | null
      Counties: string[]
  }
): Promise<Props> {
    const initialPlotP = fetch(`/plots/${njspPlotSpec.name}.json`).then(r => r.json() as Promise<PlotParams>)
    const rundateP = fetch("/njsp/rundate.json").then(r => r.json()).then(o => o.rundate as string)
  const typeProjectionsP =
    fetch(ProjectedCsv)
        .then(r => r.text())
        .then(text => db.registerFileText("projected.csv", text))
        .then(() => getTypeProjections({ conn, county, }))
    const ytRowsP =
      fetch("/njsp/year-type-county.csv")
        .then(r => r.text())
        .then(text => db.registerFileText("year-type-county.csv", text))
        .then(() => {
          const target = `read_csv('year-type-county.csv')`
          const query = ytcQuery({ county: county ?? null, target })
          console.log("duckdb querying:", query)
          return conn.query(query)
        })
        .then(r => JSON.parse(JSON.stringify(r.toArray() as YtRow[])))
    const [ initialPlot, rundate, ytRows, typeProjections, ] = await Promise.all([ initialPlotP, rundateP, ytRowsP, typeProjectionsP, ])
    console.log(`rundate: ${rundate}`, "ytRows:", ytRows)
    return {
        initialPlot,
        typeProjections,
        ytRows,
        rundate,
        county,
        Counties,
    }
}
