import { loadPlot } from "@rdub/next-plotly/plot-load";
import { Data, njspPlotSpec, YearTotalsMap, } from "@/src/plotSpecs";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { AllTypes, getPlotData, PlotParams, Props, TypeCounts, } from "@/src/njsp/plot";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { basename } from "path";
import fs from "fs";
import { loadSync } from "@rdub/base/load";
import { fromEntries } from "@rdub/base/objs";
import { NJSP, NJSP_DATA, ProjectedCsv, RUNDATE_RELPATH, YearTypeCountyCsv } from "../paths";

export async function getTypeProjections(db: AsyncDuckDB): Promise<TypeCounts> {
    const projectedCsvText = fs.readFileSync(ProjectedCsv).toString()
    const name = basename(ProjectedCsv)
    await db.registerFileText(name, projectedCsvText)
    const [ typeProjections ] = await runQuery<TypeCounts>(
        db,
        `
        SELECT
            CAST(sum(driver) as INT) as driver,
            CAST(sum(pedestrian) as INT) as pedestrian,
            CAST(sum(cyclist) as INT) as cyclist,
            CAST(sum(passenger) as INT) as passenger
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
    const tableData: TableData = loadTableData(YearTypeCountyCsv)
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const { data, rows, annotations } = await getPlotData({
        db,
        target,
        typeProjections,
        initialPlotData,
        types: new Set(AllTypes)
    })

    const yearTotalsMap = fromEntries(
        rows.map(
            ({ year, total, projected }) =>
            [ year, { total, projected } ]
        )
    ) as YearTotalsMap

    const { rundate } = loadSync<{ rundate: string }>(RUNDATE_RELPATH)
    console.log(`rundate: ${rundate}`)
    return {
        params: { data, layout: { ...layout, annotations }, ...plotRest },
        tableData,
        typeProjections,
        rundate,
        yearTotalsMap,
    }
}
