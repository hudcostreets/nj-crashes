import { loadPlot } from "@rdub/next-plotly/plot-load";
import { njspPlotSpec } from "@/src/plotSpecs";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { getPlotData, PlotParams, Props } from "@/src/njsp/plot";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import path, { dirname } from "path";
import fs from "fs";

export async function getProjectedTotal(db: AsyncDuckDB) {
    const projectedCsvPath = path.join(dirname(process.cwd()), "data/njsp/projected.csv")
    const projectedCsvText = fs.readFileSync(projectedCsvPath).toString()
    const name = "projected.csv"
    await db.registerFileText(name, projectedCsvText)
    const [{ projectedTotal }] = await runQuery<{ projectedTotal: number }>(
        db,
        `select cast(sum(driver + pedestrian + passenger + cyclist) as integer) as projectedTotal from ${name}`
    )
    console.log("projectedTotal:", projectedTotal)
    return projectedTotal
}

export async function loadProps(): Promise<Props> {
    const initialPlot = loadPlot(njspPlotSpec) as PlotParams   // TODO: push cast into loadPlot
    const {
        data: initialPlotData,
        layout,
        ...plotRest
    } = initialPlot
    const db = await initDuckDb()
    const projectedTotal = await getProjectedTotal(db)
    // const crashesBase64 = loadParquetBase64("data/crashes.pqt")
    const tableData: TableData = loadTableData({ fmt: 'csv', stem: "data/njsp/year-type-county" })
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const { data, annotations } = await getPlotData({
        db,
        target,
        projectedTotal,
        initialPlotData,
    })

    return {
        params: { data, layout: { ...layout, annotations }, ...plotRest },
        tableData,
        projectedTotal,
    }
}
