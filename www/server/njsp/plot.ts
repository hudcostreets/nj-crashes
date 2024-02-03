import { loadPlot } from "@rdub/next-plotly/plot-load";
import { curYear, Data, njspPlotSpec, ProjectedTotals, prvYear } from "@/src/plotSpecs";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { AllTypes, getPlotData, PlotParams, Props, YtRow } from "@/src/njsp/plot";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import path, { dirname } from "path";
import fs from "fs";
import { loadSync } from "@rdub/base/load";
import { fromEntries } from "@rdub/base/objs";

export async function getTypeProjections(db: AsyncDuckDB) {
    const projectedCsvPath = path.join(dirname(process.cwd()), "data/njsp/projected.csv")
    const projectedCsvText = fs.readFileSync(projectedCsvPath).toString()
    const name = "projected.csv"
    await db.registerFileText(name, projectedCsvText)
    const [ typeProjections ] = await runQuery<YtRow>(
        db,
        `
        SELECT
            CAST(sum(driver) as INT) as driver,
            CAST(sum(pedestrian) as INT) as pedestrian,
            CAST(sum(cyclist) as INT) as cyclist,
            CAST(sum(passenger) as INT) as passenger,
        FROM ${name}
        `,
    )
    console.log("typeProjections:", typeProjections)
    return typeProjections
}

export async function loadProps(): Promise<Props> {
    const initialPlot = loadPlot<Data, PlotParams>(njspPlotSpec)
    const {
        data: initialPlotData,
        layout,
        ...plotRest
    } = initialPlot
    const db = await initDuckDb()
    const typeProjections = await getTypeProjections(db)
    const tableData: TableData = loadTableData({ fmt: 'csv', stem: "data/njsp/year-type-county" })
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const { data, rows, annotations } = await getPlotData({
        db,
        target,
        typeProjections,
        initialPlotData,
        types: new Set(AllTypes)
    })

    const ytcMap = fromEntries(
        rows.map(
            ({ year, total, projected }) =>
            [ year, { total, projected } ]
        )
    )

    const projectedTotal = typeProjections.driver + typeProjections.pedestrian + typeProjections.cyclist + typeProjections.passenger

    const { rundate } = loadSync<{ rundate: string }>(`public/rundate.json`)
    console.log(`rundate: ${rundate}`)
    const projectedTotals: ProjectedTotals = {
        2021: ytcMap[2021].total,
        2022: ytcMap[2022].total,
    }
    projectedTotals[prvYear] = ytcMap[prvYear].total
    projectedTotals[curYear] = projectedTotal
    return {
        params: { data, layout: { ...layout, annotations }, ...plotRest },
        tableData,
        typeProjections,
        rundate,
        projectedTotals,
    }
}
