import { Annotations, PlotData } from "plotly.js";
import * as Plotly from "react-plotly.js";
import { registerTableData, TableData } from "@/src/tableData";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { njspPlotSpec } from "@/src/plotSpecs";
import PlotWrapper from "@rdub/next-plotly/plot-wrapper";
import React, { useEffect, useState } from "react";

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type Props = {
    params: PlotParams
    tableData: TableData
    projectedTotal: number
}

export type YtcRow = {
    year: number
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
    total: number
    projected: number
}

export async function getPlotData({ db, target, projectedTotal, initialPlotData }: {
    db: AsyncDuckDB
    target: string
    projectedTotal: number
    initialPlotData: PlotData[]
}): Promise<{
    rows: YtcRow[]
    data: PlotData[]
    annotations: Annotation[]
}> {
    let query: string
    query = `
        SELECT
            year,
            CAST(sum(driver) as INTEGER) as driver,
            CAST(sum(pedestrian) as INTEGER) as pedestrian,
            CAST(sum(cyclist) as INTEGER) as cyclist,
            CAST(sum(passenger) as INTEGER) as passenger,
            CAST(sum(driver + pedestrian + cyclist + passenger) as INTEGER) as total,
            NULL as projected
        FROM ${target}
        GROUP BY year
    `
    const rows = await runQuery<YtcRow>(db, query)
    const last = rows[rows.length - 1]
    last.projected = projectedTotal - last.total
    console.log("got ytc data:", rows)
    const typesMap: { [k: string]: keyof YtcRow } = {
        "Drivers": "driver",
        "Pedestrians": "pedestrian",
        "Cyclists": "cyclist",
        "Passengers": "passenger",
        "Projected": "projected",
    }
    const data = initialPlotData.map(series => {
        const type = typesMap[series.name]
        const newSeries: PlotData = { ...series }
        newSeries.x = rows.map(r => r.year)
        newSeries.y = rows.map(r => r[type])
        return newSeries
    })
    const annotations: Annotation[] = rows.map(({ year, total, projected }) => {
        const y = total + projected
        return {
            x: year,
            y,
            text: `${y}`,
            showarrow: false,
            yshift: 10,
        }
    })
    return { rows, data, annotations }
}

export const title = "New Jersey Car Crash Deaths"

export function NjspPlot({ params, tableData, projectedTotal, }: Props) {
    const spec = njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ db, setDb ] = useState<AsyncDuckDB | null>(null)
    const [ rows, setRows ] = useState<any[] | null>(null)
    const { data: initialPlotData, layout, ...plotRest } = params as PlotParams
    const [ data, setData ] = useState<PlotData[]>(initialPlotData)
    const [ annotations, setAnnotations ] = useState<Annotation[] | undefined>(layout.annotations)

    useEffect(
        () => {
            async function init() {
                const db = await initDuckDb()
                console.log("got db:", db)
                setDb(db)
                const target = await registerTableData({ db, tableData, stem: "ytc", })
                console.log("registered target:", target)
                const { rows, data, annotations } = await getPlotData({
                    db,
                    target,
                    projectedTotal,
                    initialPlotData,
                })
                console.log("data:", data)
                setRows(rows)
                setData(data)
                setAnnotations(annotations)
            }
            init()
        },
        [ tableData, ]
    )

    return (
        <PlotWrapper
            params={{ data: data, layout: { ...layout, annotations }, ...plotRest }}
            src={src}
            alt={title}
            // margin={{b: 30,}}
        />
    )
}
