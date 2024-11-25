import { Annotations, Layout, PlotData } from "plotly.js";
import * as Plotly from "react-plotly.js";
import { curYear, Data, njspPlotSpec, prvYear, YearTotalsMap } from "@/src/plotSpecs";
import React, { Dispatch, ReactNode, useCallback, useMemo, useState } from "react";
import { HasCounty, typeCountsQuery } from "./projections";
import { repoWithOwner } from "@/src/github";
import A from "@rdub/next-base/a";
import { GitHub } from "@/src/socials";
import { Plot, PlotSpec } from "@rdub/next-plotly/plot";
import { fromEntries, sum } from "@rdub/base/objs";
import { normalize } from "../county";
import { CountySelect } from "../county-select";
import { NjspSource } from "@/src/icons";
import IntrinsicElements = React.JSX.IntrinsicElements;
import { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { ProjectedCsv } from "@/src/paths";
import { ytcQuery } from "@/src/njsp/ytc";

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type TypeCounts = {
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
}

export type Props = {
    initialPlot: PlotParams
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

export async function getTypeProjections({ conn, county, }: { conn: AsyncDuckDBConnection, county: string | null, }): Promise<TypeCounts> {
    const query = typeCountsQuery(county)
    console.log("getTypeProjections query:", query)
    // await db.registerFileURL('projected.csv', '/njsp/projected.csv', false)
    const [ typeCounts ] = JSON.parse(JSON.stringify((await (conn.query(query))).toArray()))
    // const [ typeCounts ] = await getCsvTable<TypeCounts>({ db, query, })
    return typeCounts
}

export async function loadProps(
  { db, conn, county, Counties, }: {
      db: AsyncDuckDB
      conn: AsyncDuckDBConnection
      county: string | null
      Counties: string[]
  }
): Promise<Props> {
    const initialPlotP = fetch(`/plots/${njspPlotSpec.name}.json`).then(r => r.json() as Promise<PlotParams>)
    const rundateP = fetch("/njsp/rundate.json").then(r => r.json()).then(o => o.rundate as string)
    const typeProjectionsP =
      fetch(ProjectedCsv)
        .then(r => r.text())
        .then(text => db.registerFileText("projected.csv", text))
        .then(() => getTypeProjections({ conn, county, }))
    const ytRowsP =
      fetch("/njsp/year-type-county.csv")
        .then(r => r.text())
        .then(text => db.registerFileText("year-type-county.csv", text))
        .then(() => {
            const target = `read_csv('year-type-county.csv')`
            const query = ytcQuery({ county: county ?? null, target })
            console.log("duckdb querying:", query)
            return conn.query(query)
        })
        .then(r => JSON.parse(JSON.stringify(r.toArray() as YtRow[])))
    const [ initialPlot, rundate, ytRows, typeProjections, ] = await Promise.all([ initialPlotP, rundateP, ytRowsP, typeProjectionsP, ])
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

export function getPlotData({ ytRows, typeProjections, initialPlotData, types, showProjected, county, }: {
    ytRows: YtRow[]
    typeProjections: TypeCounts
    initialPlotData: PlotData[]
    types: Set<Type>
    showProjected: boolean
    county?: string | null
}): {
    rows: YtRow[]
    data: PlotData[]
    annotations: Annotation[]
    yearTotalsMap: YearTotalsMap
    maxY: number
} {
    // console.log("getPlotData: county", county)
    const typesArr = Array.from(types)
    const typesMap: { [k: string]: keyof TypeCounts } = {
        "Drivers": "driver",
        "Pedestrians": "pedestrian",
        "Cyclists": "cyclist",
        "Passengers": "passenger",
    }
    console.log("typeProjections:", typeProjections)
    const projectedTotal = sum(Types.map(type => {
        const col = typesMap[type] as keyof TypeCounts
        return col in typeProjections ? typeProjections[col] : 0
    }))
    const typesProjectedTotal = sum(typesArr.map(type => {
        const col = typesMap[type] as keyof TypeCounts
        return col in typeProjections ? typeProjections[col] : 0
    }))
    // console.log("ytRows:", ytRows)
    const last = { ...ytRows[ytRows.length - 1] }
    const rows = [ ...ytRows.slice(0, ytRows.length - 1), last ]
    const typeRows: YtRow[] = ytRows.map(({ year, ...row }) => {
        const total = sum(typesArr.map(type => row[typesMap[type]]))
        return { year, ...row, total, projected: 0 }
    })
    if (last.year == curYear) {
        const lastTotal = sum(Types.map(type => last[typesMap[type]]))
        console.log("projectedTotal:", projectedTotal, "lastTotal:", lastTotal, "original last:", ytRows[ytRows.length - 1])
        last.projected = projectedTotal - lastTotal
        if (showProjected) {
            const typesLastTotal = sum(typesArr.map(type => last[typesMap[type]]))
            typeRows[typeRows.length - 1].projected = typesProjectedTotal - typesLastTotal
        }
    } else {
        console.warn(`getPlotData: last year is not ${curYear}:`, last, ` (county: ${county})`, ytRows)
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
    const isSolo = types.size === 1
    console.log("got ytc data:", rows, "isSolo:", isSolo)
    // console.log("getPlotData: types:", types)
    const data = initialPlotData.map(series => {
        const { name } = series
        const type = name as LegendType
        const col = name === "Projected" ? "projected" : typesMap[type]
        const newSeries: PlotData = { ...series }
        newSeries.x = typeRows.map(r => r.year)
        newSeries.y = typeRows.map(r => r[col])
        if (type === "Projected") {
            newSeries.visible = showProjected ? true : "legendonly"
        } else {
            newSeries.visible = types.has(type) ? true : "legendonly"
        }
        if (!isSolo) {
            newSeries.textposition = "inside"
        }
        return newSeries
    })
    const annotations: Annotation[] = typeRows.map(row => {
        const { year, projected } = row
        if (isSolo && (!showProjected || !projected)) return null
        const y = sum(typesArr.map(type => row[typesMap[type]])) + (showProjected ? projected : 0)
        const a: Annotation = {
            x: year,
            y,
            text: `${y}`,
            showarrow: false,
            yshift: 10,
        }
        return a
    }).filter((a): a is Annotation => a !== null)
    typeRows.forEach(row => {
        const { year, projected } = row
        if (isSolo || (!showProjected || !projected)) return
        const y = sum(typesArr.map(type => row[typesMap[type]]))
        if (projected / y > 0.1) {
            annotations.push({
                x: year,
                y,
                text: `${y}`,
                showarrow: false,
                yshift: 10,
            })
        }
    })
    const yearTotalsMap = fromEntries(
        rows.map(
            ({ year, total, projected }) =>
                [ year, { total, projected } ]
        )
    ) as YearTotalsMap

    const maxY = typeRows.map(({ total, projected, }) => total + (projected ?? 0)).reduce((a, b) => Math.max(a, b), 0)

    // console.log("annotations:", annotations)
    return { rows: typeRows, data, annotations, yearTotalsMap, maxY, }
}

export const DefaultTitle = "Car Crash Deaths"

export type Type = "Drivers" | "Pedestrians" | "Cyclists" | "Passengers"
export const Types: Type[] = ["Drivers", "Pedestrians", "Cyclists", "Passengers"]
export type LegendType = Type | "Projected"

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
    }: Data & HasCounty & MoreInfoLink & { yearTotalsMap: YearTotalsMap }
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
        initialPlot,
        typeProjections,
        Counties,
        rundate,
        ytRows,
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
        Heading?: keyof IntrinsicElements
    }
) {
    spec = spec ?? njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ types, setTypes ] = useState<Set<Type>>(new Set(Types))
    const [ showProjected, setShowProjected ] = useState(true)
    const { data: initialPlotData, layout, ...plotRest } = initialPlot as PlotParams

    const onLegendClick = useCallback(
        (name: LegendType) => {
            if (name === "Projected") {
                setShowProjected(!showProjected)
            } else if (types.has(name)) {
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
        [ types, setTypes, showProjected, setShowProjected ]
    )

    const onLegendDoubleClick = useCallback(
        (name: LegendType) => {
            if (name === "Projected") {

            } else if (types.size <= 1) {
                // Remove solo; show all traces
                console.log(`types: remove solo ${name}`)
                setTypes(new Set(Types))
            } else {
                // Solo trace
                console.log(`types: solo ${name}`)
                setTypes(new Set([ name ]))
            }
            return false
        },
        [ types ]
    )

    const tickOpts = [ 5, 10, 20, 25, 50, 100 ]
    const { data, annotations, yearTotalsMap, maxY, } = getPlotData({
        ytRows,
        typeProjections,
        initialPlotData,
        types,
        showProjected,
        county,
    })
    const ytick = tickOpts.filter(tick => maxY / tick <= 20)[0]
    console.log("plot data:", data, "yearTotalsMap:", yearTotalsMap, "ytick:", ytick, "maxY:", maxY)
    const newLayout: Partial<Layout> = useMemo(
        () => {
            const { xaxis, yaxis: { dtick, ...yaxis } = {}, title, ...rest } = layout
            return {
                ...rest,
                xaxis: { ...xaxis, fixedrange: true },
                yaxis: { ...yaxis, fixedrange: true, dtick: ytick, },
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
