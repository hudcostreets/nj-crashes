import { loadPlot } from "@rdub/next-plotly/plot-load";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { Counties } from "@/server/county";
import { AllTypes, getPlotData, njspPlotSpec, PlotParams, Props, YtRow, } from "@/src/njsp/plot";
import { loadSync } from "@rdub/base/load";
import { RUNDATE_RELPATH, YearTypeCountyCsv } from "../paths";
import { getTypeProjections } from "./projections";
import { ytcQuery } from "@/src/njsp/ytc";

export async function loadProps({ county }: { county: string | null } = { county: null }): Promise<Props> {
    const initialPlot = loadPlot<PlotParams>(njspPlotSpec)
    const {
        data: initialPlotData,
        layout,
        ...plotRest
    } = initialPlot
    const db = await initDuckDb()
    const typeProjections = await getTypeProjections({ db, county, })
    const tableData: TableData = loadTableData(YearTypeCountyCsv)
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const initRows = await runQuery<YtRow>(db, ytcQuery({ county: county ?? null, target }))
    const { data, rows: ytRows, annotations, yearTotalsMap, } = await getPlotData({
        ytRows: initRows,
        typeProjections,
        initialPlotData,
        types: new Set(AllTypes),
        county,
    })

    const { rundate } = loadSync<{ rundate: string }>(RUNDATE_RELPATH)
    console.log(`rundate: ${rundate}`)
    return {
        params: { data, layout: { ...layout, annotations }, ...plotRest },
        tableData,
        typeProjections,
        ytRows,
        rundate,
        yearTotalsMap,
        county,
        Counties,
    }
}
