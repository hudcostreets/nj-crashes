import { Annotations, Layout, PlotData } from "plotly.js";
import * as Plotly from "react-plotly.js";
import { TableData, useCsvTable, useTable } from "@/src/tableData";
import { useDb, useQuery, } from "@rdub/duckdb/duckdb";
import { curYear, Data, njspPlotSpec, prvYear, YearTotalsMap } from "@/src/plotSpecs";
import React, { Dispatch, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { HasCounty, table, typeCountsQuery } from "./projections";
import { ProjectedCsv } from "@/src/paths";
import { ytcQuery } from "@/src/njsp/ytc";
import { repoWithOwner } from "@/src/github";
import A from "@/src/lib/a"
import { GitHub } from "@/src/socials"
import { Plot, PlotSpec } from "@/src/lib/plot"
import { fromEntries } from "@rdub/base/objs";
import { normalize } from "../county";
import { CountySelect } from "../county-select";
import { NjspSource } from "@/src/icons";
import { Crash, Total } from "@/src/use-njsp-crashes";

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type InitProps = {
    crashes: Crash[]
    totals: Total[]
}

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
    ytRows: YtRow[]
    county: string | null
    Counties: string[]
    title?: string
    heading?: ReactNode
    spec?: PlotSpec
} & Data

export type YtRow = {
    year: number
} & TypeCounts & {
    total: number
    projected: number
}

export async function getPlotData({ ytRows, typeProjections, initialPlotData, types, county, }: {
    ytRows: YtRow[]
    typeProjections: TypeCounts
    initialPlotData: PlotData[]
    types: Set<Type>
    county?: string | null
}): Promise<{
    rows: YtRow[]
    data: PlotData[]
    annotations: Annotation[]
    yearTotalsMap: YearTotalsMap
}> {
    // console.log("getPlotData: county", county)
    const typesArr = Array.from(types)
    const typesMap: { [k: string]: keyof YtRow } = {
        "Drivers": "driver",
        "Pedestrians": "pedestrian",
        "Cyclists": "cyclist",
        "Passengers": "passenger",
        "Projected": "projected",
    }
    console.log("typeProjections:", typeProjections)
    const projectedTotal = typesArr.map(type => {
        const col = typesMap[type] as keyof TypeCounts
        return col in typeProjections ? typeProjections[col] : 0
    }).reduce((a, b) => a + b, 0)
    // console.log("ytRows:", ytRows)
    const last = { ...ytRows[ytRows.length - 1] }
    const rows = [ ...ytRows.slice(0, ytRows.length - 1), last ]
    if (last.year == curYear) {
        const lastTotal = typesArr.map(type => last[typesMap[type]]).reduce((a, b) => a + b, 0)
        last.projected = projectedTotal - lastTotal
    } else {
        console.warn(`getPlotData: last year is not ${curYear}:`, last, ` (county: ${county})`)
        rows.push({
            year: curYear,
            driver: 0,
            pedestrian: 0,
            cyclist: 0,
            passenger: 0,
            total: 0,
            projected: projectedTotal,
        })
    }
    // console.log("got ytc data:", rows)
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
        const { year, } = row
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
    const yearTotalsMap = fromEntries(
        rows.map(
            ({ year, total, projected }) =>
                [ year, { total, projected } ]
        )
    ) as YearTotalsMap

    // console.log("annotations:", annotations)
    return { rows, data, annotations, yearTotalsMap, }
}

export const DefaultTitle = "Car Crash Deaths"

export const AllTypes: Type[] = ["Drivers", "Pedestrians", "Cyclists", "Passengers", "Projected"]
export type Type = "Drivers" | "Pedestrians" | "Cyclists" | "Passengers" | "Projected"

export const estimationHref = `https://nbviewer.org/github/${repoWithOwner}/blob/main/njsp/update-projections.ipynb`

export type MoreInfoLink = {
    includeMoreInfoLink?: boolean
}

export function NjspChildren(
    {
        rundate,
        yearTotalsMap,
        county,
        includeMoreInfoLink,
    }: Data & HasCounty & MoreInfoLink
) {
    const total2021 = yearTotalsMap["2021"].total
    const total2022 = yearTotalsMap["2022"].total
    const prvYearTotal = yearTotalsMap[prvYear].total
    const curYearMap = yearTotalsMap[curYear]
    if (!curYearMap) {
        console.warn(`NjspChildren: yearTotalsMap doesn't contain ${curYear}:`, yearTotalsMap)
        return null
    }
    const { total: curYearTotal, projected: curYearProjected } = curYearMap
    const curYearProjectedTotal = curYearTotal + curYearProjected
    const shortDate = new Date(rundate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: 'UTC' })
    return <>
        <p>Click/Double-click the legend labels to toggle or solo each type.</p>
        <p>
            <A href={`${GitHub.href}/commits/main`}>As of {shortDate}</A>, {county ? `${county} County` : "NJ"} has {curYearTotal} reported deaths in {curYear}, and <A href={estimationHref}>is on pace</A> for {curYearProjectedTotal}{curYearProjectedTotal > prvYearTotal ? `, exceeding ${prvYear}'s ${prvYearTotal}` : ""}.
            {includeMoreInfoLink ? <>{' '}<A href={`/c/${county ? normalize(county) : ""}`}>More {county ? `${county} County` : "state-wide"} data</A>.</> : null}
        </p>
        {county === null ? <p>2021 and 2022 were the worst years in the NJSP record (since 2008), with {total2021} and {total2022} deaths, resp.</p> : null}
        <NjspSource />
        {/*<p>Data comes from <A title={"NJ State Police fatal crash data"} href={NjspFatalAcc}>NJ State Police</A>, and is updated daily (though crashes sometimes take weeks or months to show up).</p>*/}
    </>
}

export function NjspPlot(
    {
        params,
        tableData,
        typeProjections,
        Counties,
        ytRows: initYtRows,
        rundate,
        yearTotalsMap: initYearTotalsMap,
        county,
        title,
        subtitle,
        heading,
        Heading = 'h2',
        spec,
        setCounty,
        includeMoreInfoLink,
    }: Props & MoreInfoLink & {
        subtitle?: ReactNode
        setCounty?: Dispatch<string | null>
        Heading?: keyof JSX.IntrinsicElements
    }
) {
    spec = spec ?? njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ types, setTypes ] = useState<Set<Type>>(new Set(AllTypes))
    const db = useDb()
    const { data: initialPlotData, layout, ...plotRest } = params as PlotParams
    const [ data, setData ] = useState<PlotData[]>(initialPlotData)
    const [ annotations, setAnnotations ] = useState<Annotation[] | undefined>(layout.annotations)
    const [ projections ] = useCsvTable({
        url: ProjectedCsv,
        db,
        table,
        query: typeCountsQuery(county),
        init: [ typeProjections ],
    })
    const [ yearTotalsMap, setYearTotalsMap ] = useState<YearTotalsMap>(initYearTotalsMap)

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

    const target = useTable({ db, tableData, stem: "ytc" })
    const [ ytQuery, setYtQuery ] = useState<string | null>(null)
    useEffect(
        () => {
            if (!db || !target) return
            const query = ytcQuery({ county: county ?? null, target })
            console.log("updating ytQuery:", query)
            setYtQuery(query)
        },
        [ db, target, county, ]
    )
    const ytRows = useQuery<YtRow>({ db, query: ytQuery, init: initYtRows, })

    useEffect(
        () => {
            async function query() {
                if (!db || !target) return
                // console.log("types:", Array.from(types))
                const { data, annotations, yearTotalsMap, } = await getPlotData({
                    ytRows,
                    typeProjections: projections,
                    initialPlotData,
                    types,
                    county,
                })
                // console.log("plot data:", data, "county:", county)
                // setRows(rows)
                setData(data)
                setAnnotations(annotations)
                setYearTotalsMap(yearTotalsMap)
            }
            query()
        },
        [ db, target, ytRows, projections, initialPlotData, types, county, ]
    )
    //console.log("trace visibility:", data.map(d => d.visible))
    const newLayout: Partial<Layout> = useMemo(
        () => {
            const { xaxis, yaxis, title: _title, ...rest } = layout
            return {
                ...rest,
                xaxis: { ...xaxis, fixedrange: true },
                yaxis: { ...yaxis, fixedrange: true },
                dragmode: false,
                annotations,
                margin: { t: 0, r: 10, b: 0, l: 0, },
            }
        },
        [ layout, annotations ],
    )
    title = title ?? DefaultTitle
    return (
        <Plot
            {...spec}
            params={{ data, layout: newLayout, ...plotRest }}
            src={src}
            title={title}
            subtitle={subtitle}
            heading={
                heading ?? (
                    setCounty
                        ? <Heading>
                            <A href={`#${spec.id}`}>{title}</A>:
                            <CountySelect
                                county={county}
                                setCounty={setCounty}
                                Counties={Counties}
                            />
                        </Heading>
                        : null
                )
            }
            onLegendClick={onLegendClick}
            onLegendDoubleClick={onLegendDoubleClick}
        >
            <NjspChildren
                rundate={rundate}
                yearTotalsMap={yearTotalsMap}
                county={county}
                includeMoreInfoLink={includeMoreInfoLink}
            />
        </Plot>
    )
}
