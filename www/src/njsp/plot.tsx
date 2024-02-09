import { Annotations, PlotData } from "plotly.js";
import * as Plotly from "react-plotly.js";
import { registerTableData, TableData } from "@/src/tableData";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { Data, njspPlotSpec, Plot } from "@/src/plotSpecs";
import React, { useCallback, useEffect, useState } from "react";

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type TypeCounts = {
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
}

export type Props = {
    params: PlotParams
    tableData: TableData
    typeProjections: TypeCounts
} & Data

export type YtRow = {
    year: number
} & TypeCounts & {
    total: number
    projected: number
}

export async function getPlotData({ db, target, typeProjections, initialPlotData, types, }: {
    db: AsyncDuckDB
    target: string
    typeProjections: TypeCounts
    initialPlotData: PlotData[]
    types: Set<Type>
}): Promise<{
    rows: YtRow[]
    data: PlotData[]
    annotations: Annotation[]
}> {
    const query = `
        SELECT
            year,
            CAST(sum(driver) as INT) as driver,
            CAST(sum(pedestrian) as INT) as pedestrian,
            CAST(sum(cyclist) as INT) as cyclist,
            CAST(sum(passenger) as INT) as passenger,
            CAST(sum(driver + pedestrian + cyclist + passenger) as INT) as total,
            NULL as projected
        FROM ${target}
        GROUP BY year
    `
    const rows = await runQuery<YtRow>(db, query)
    const typesArr = Array.from(types)
    const typesMap: { [k: string]: keyof YtRow } = {
        "Drivers": "driver",
        "Pedestrians": "pedestrian",
        "Cyclists": "cyclist",
        "Passengers": "passenger",
        "Projected": "projected",
    }
    const projectedTotal = typesArr.map(type => {
        const col = typesMap[type] as keyof TypeCounts
        return col in typeProjections ? typeProjections[col] : 0
    }).reduce((a, b) => a + b, 0)
    const last = rows[rows.length - 1]
    const lastTotal = typesArr.map(type => last[typesMap[type]]).reduce((a, b) => a + b, 0)
    last.projected = projectedTotal - lastTotal
    console.log("got ytc data:", rows)
    const isSolo = types.size === 1
    // console.log("getPlotData: types:", types)
    const data = initialPlotData.map(series => {
        const { name } = series
        const type = name as Type
        const col = typesMap[type]
        const newSeries: PlotData = { ...series }
        newSeries.x = rows.map(r => r.year)
        newSeries.y = rows.map(r => r[col])
        newSeries.visible = types.has(type) ? true : "legendonly"
        if (!isSolo) {
            newSeries.textposition = "inside"
        }
        return newSeries
    })
    const annotations: Annotation[] = isSolo ? [] : rows.map(row => {
        const { year, projected, } = row
        const total = typesArr.map(type => row[typesMap[type]]).reduce((a, b) => a + b, 0)
        const y = total //+ projected
        return {
            x: year,
            y,
            text: `${y}`,
            showarrow: false,
            yshift: 10,
        }
    })
    // console.log("annotations:", annotations)
    return { rows, data, annotations }
}

export const title = "New Jersey Car Crash Deaths"

export const AllTypes: Type[] = ["Drivers", "Pedestrians", "Cyclists", "Passengers", "Projected"]
export type Type = "Drivers" | "Pedestrians" | "Cyclists" | "Passengers" | "Projected"

export function NjspPlot({ params, tableData, typeProjections, rundate, yearTotalsMap, }: Props) {
    const spec = njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ types, setTypes ] = useState<Set<Type>>(new Set(AllTypes))
    const [ db, setDb ] = useState<AsyncDuckDB | null>(null)
    const [ rows, setRows ] = useState<any[] | null>(null)
    const { data: initialPlotData, layout, ...plotRest } = params as PlotParams
    const [ data, setData ] = useState<PlotData[]>(initialPlotData)
    const [ annotations, setAnnotations ] = useState<Annotation[] | undefined>(layout.annotations)
    const [ target, setTarget ] = useState<string | null>(null)

    const onLegendClick = useCallback(
        (name: Type) => {
            if (types.has(name)) {
                console.log(`types: disable ${name}`)
                const newTypes = new Set(Array.from(types))
                newTypes.delete(name)
                setTypes(newTypes)
            } else {
                console.log(`types: enable ${name}`)
                const newTypes = new Set(Array.from(types))
                newTypes.add(name)
                setTypes(newTypes)
            }
            return false
        },
        [ types ]
    )

    const onLegendDoubleClick = useCallback(
        (name: Type) => {
            if (types.size <= 1) {
                // Remove solo; show all traces
                console.log(`types: remove solo ${name}`)
                setTypes(new Set(AllTypes))
            } else {
                // Solo trace
                console.log(`types: solo ${name}`)
                setTypes(new Set([ name ]))
            }
            return false
        },
        [ types ]
    )

    useEffect(
        () => {
            async function init() {
                const db = await initDuckDb()
                console.log("got db:", db)
                setDb(db)
                const target = await registerTableData({ db, tableData, stem: "ytc", })
                console.log("registered target:", target)
                setTarget(target)
            }
            init()
        },
        [ tableData, ]
    )

    useEffect(
        () => {
            async function query() {
                if (!db || !target) return
                // console.log("types:", Array.from(types))
                const {rows, data, annotations} = await getPlotData({
                    db,
                    target,
                    typeProjections,
                    initialPlotData,
                    types,
                })
                // console.log("data:", data)
                setRows(rows)
                setData(data)
                setAnnotations(annotations)
            }
            query()
        },
        [ db, target, typeProjections, initialPlotData, types ]
    )

    console.log("trace visibility:", data.map(d => d.visible))
    return (
        <Plot
            {...spec}
            params={{ data, layout: { ...layout, annotations }, ...plotRest }}
            src={src}
            title={title}
            data={{ rundate, yearTotalsMap }}
            onLegendClick={onLegendClick}
            onLegendDoubleClick={onLegendDoubleClick}
        />
    )
}
