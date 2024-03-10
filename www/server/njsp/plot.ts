import { loadPlot } from "@rdub/next-plotly/plot-load";
import { Data, njspPlotSpec, YearTotalsMap, } from "@/src/plotSpecs";
import { initDuckDb } from "@rdub/duckdb/duckdb";
import { registerTableData, TableData } from "@/src/tableData";
import { loadTableData } from "@/server/tableData";
import { AllTypes, getPlotData, PlotParams, Props, } from "@/src/njsp/plot";
import { loadSync } from "@rdub/base/load";
import { fromEntries } from "@rdub/base/objs";
import { RUNDATE_RELPATH, YearTypeCountyCsv } from "../paths";
import { getTypeProjections } from "./projections";

export async function loadProps({ county }: { county: string | null } = { county: null }): Promise<Props> {
    const initialPlot = loadPlot<Data, PlotParams>(njspPlotSpec)
    const {
        data: initialPlotData,
        layout,
        ...plotRest
    } = initialPlot
    const db = await initDuckDb()
    const typeProjections = await getTypeProjections({ db, county, })
    const tableData: TableData = loadTableData(YearTypeCountyCsv)
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const { data, rows, annotations } = await getPlotData({
        db,
        target,
        typeProjections,
        initialPlotData,
        types: new Set(AllTypes),
        county,
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
        county,
    }
}
