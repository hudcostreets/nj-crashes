import { loadPlot } from "@rdub/next-plotly/plot-load";
import { Data, njspPlotSpec, YearTotalsMap, } from "@/src/plotSpecs";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { AllTypes, getPlotData, PlotParams, Props, YtRow, } from "@/src/njsp/plot";
import { loadSync } from "@rdub/base/load";
import { fromEntries } from "@rdub/base/objs";
import { RUNDATE_RELPATH, YearTypeCountyCsv } from "../paths";
import { getTypeProjections } from "./projections";
import { ytcQuery } from "@/src/njsp/ytc";
import { cn2cc } from "@/server/county";
import { keys } from "@rdub/base/objs";
import { Arr } from '@rdub/base/arr';

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
    const { data, rows: ytRows, annotations } = await getPlotData({
        ytRows: initRows,
        typeProjections,
        initialPlotData,
        types: new Set(AllTypes),
        county,
    })

    const yearTotalsMap = fromEntries(
        ytRows.map(
            ({ year, total, projected }) =>
            [ year, { total, projected } ]
        )
    ) as YearTotalsMap

    const counties = Arr(keys(cn2cc))
    const { rundate } = loadSync<{ rundate: string }>(RUNDATE_RELPATH)
    console.log(`rundate: ${rundate}`)
    return {
        params: { data, layout: { ...layout, annotations }, ...plotRest },
        tableData,
        typeProjections,
        ytRows,
        rundate,
        counties,
        yearTotalsMap,
        county,
    }
}
