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
    const initialPlot = await (await fetch(`/plots/${njspPlotSpec.name}.json`)).json() as PlotParams
    const rundate = (await (await fetch("/njsp/rundate.json")).json()).rundate as string
    const projectedCsv = await (await fetch(ProjectedCsv)).text()
    await db.registerFileText("projected.csv", projectedCsv)
    const typeProjections = await getTypeProjections({ conn, county, })
    const ytcCsv = await (await fetch("/njsp/year-type-county.csv")).text()
    await db.registerFileText("year-type-county.csv", ytcCsv)
    const target = `read_csv('year-type-county.csv')`
    const query = ytcQuery({ county: county ?? null, target })
    console.log("duckdb querying:", query)
    const ytRows = JSON.parse(JSON.stringify((await conn.query(query)).toArray() as YtRow[]))
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
