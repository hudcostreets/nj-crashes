import { Annotations, Layout, PlotData } from "plotly.js";
import * as Plotly from "react-plotly.js";
import { curYear, Data, njspPlotSpec, prvYear, YearTotalsMap } from "@/src/plotSpecs";
import React, { Dispatch, ReactNode, useCallback, useMemo, useState } from "react";
import { repoWithOwner } from "@/src/github";
import A from "@rdub/next-base/a";
import { GitHub } from "@/src/socials";
import { Plot, PlotSpec } from "@rdub/next-plotly/plot";
import { fromEntries, sum } from "@rdub/base/objs";
import { normalize } from "../county";
import { CountySelect } from "../county-select";
import { NjspSource } from "@/src/icons";
import IntrinsicElements = React.JSX.IntrinsicElements;
import css from "./plot.module.scss"

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type HasCounty = {
    county: string | null
}

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
    return <div className={css.plotNotes}>
        <p>
            <A href={`${GitHub.href}/commits/main`}>As of {shortDate}</A>, {county ? `${county} County` : "NJ"} has {curYearTotal} reported deaths in {curYear}, and <A href={estimationHref}>is on pace</A> for {curYearProjectedTotal}{curYearProjectedTotal > prvYearTotal ? `, exceeding ${prvYear}'s ${prvYearTotal}` : ""}.
            {includeMoreInfoLink ? <>{' '}<A href={`/c/${county ? normalize(county) : ""}`}>More {county ? `${county} County` : "state-wide"} data</A>.</> : null}
        </p>
        {county === null ? <p>2021 and 2022 were the worst years in the NJSP record (since 2008), with {total2021} and {total2022} deaths, resp.</p> : null}
        <NjspSource />
        {/*<p>Data comes from <A title={"NJ State Police fatal crash data"} href={NjspFatalAcc}>NJ State Police</A>, and is updated daily (though crashes sometimes take weeks or months to show up).</p>*/}
    </div>
}

const TickOpts = [ 5, 10, 20, 25, 50, 100 ]

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
    const [ soloType, setSoloType ] = useState<Type>()
    const [ hoverType, setHoverType ] = useState<Type>()
    const [ showProjected, setShowProjected ] = useState(true)
    const { data: initialPlotData, layout, ...plotRest } = initialPlot as PlotParams

    const onLegendClick = useCallback(
        (name: LegendType) => {
            if (name === "Projected") {
                setShowProjected(!showProjected)
            } else if (soloType === name) {
                setSoloType(undefined)
                setHoverType(undefined)
            } else {
                setSoloType(name)
            }
            return false
        },
        [ soloType, setSoloType, showProjected, setShowProjected ]
    )

    const onLegendDoubleClick = useCallback(() => false, [])

    const onLegendMouseOver = useCallback(
        (name: LegendType) => {
            console.log("onLegendMouseOver", name)
            if (name !== "Projected") {
                setHoverType(name)
            }
            return true
        },
        []
    )

    const onLegendMouseOut = useCallback(
      (name: LegendType) => {
          console.log("onLegendMouseOut", name)
          if (name !== "Projected") {
              setHoverType(undefined)
          }
          return true
      },
      []
    )

    const types = useMemo(
      () => new Set(
        hoverType ? [ hoverType ] : soloType ? [ soloType, ] : Types
      ),
      [ hoverType, soloType, ]
    )
    console.log("types:", types, "hoverType:", hoverType, "soloType:", soloType)
    const { data, annotations, yearTotalsMap, maxY, } = getPlotData({
        ytRows,
        typeProjections,
        initialPlotData,
        types,
        showProjected,
        county,
    })
    const ytick = useMemo(() => TickOpts.filter(tick => maxY / tick <= 20)[0], [ maxY, ])
    console.log("plot data:", data, "yearTotalsMap:", yearTotalsMap, "ytick:", ytick, "maxY:", maxY)
    const [ xTickAngle, setXTickAngle ] = useState(0)
    const newLayout: Partial<Layout> = useMemo(
        () => {
            const { xaxis, yaxis: { dtick, ...yaxis } = {}, title, legend, ...rest } = layout
            return {
                ...rest,
                xaxis: { ...xaxis, fixedrange: true, tickangle: xTickAngle, },
                yaxis: { ...yaxis, fixedrange: true, dtick: ytick, },
                legend: { ...legend, y: xTickAngle < 0 ? -.1 : -.05, yanchor: "top", },
                dragmode: false,
                annotations,
                margin: { t: 0, r: 10, b: 0, l: 0, },
            }
        },
        [ layout, annotations ],
    )
    // console.log("newLayout:", newLayout, plotRest)
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
            onLegendMouseOver={onLegendMouseOver}
            onLegendMouseOut={onLegendMouseOut}
            onRelayout={(e, div) => {
                // console.log("onRelayout", e, div, div.offsetWidth)
                if (div.offsetWidth > 600) {
                    setXTickAngle(0)
                } else {
                    setXTickAngle(-45)
                }
            }}
            onXRange={(start, end) => {
                start = Math.round(start - 0.5) + 0.5
                end = Math.round(end + 0.5) - 0.5
                console.log("after rounding", start, end)
                return [ start, end ]
            }}
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
