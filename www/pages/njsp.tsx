import React, { useEffect, useState } from 'react'
import type { GetStaticProps } from "next";
import { loadPlot } from "@rdub/next-plotly/plot-load";
import { njspPlotSpec } from "@/src/plotSpecs";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { GitHub, url } from "@/src/socials";
import A from "@rdub/next-base/a";
import * as Plotly from "react-plotly.js"
import { Socials } from "@rdub/next-base/socials";
import PlotWrapper from "@rdub/next-plotly/plot-wrapper";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { Annotations, PlotData } from "plotly.js";
import { loadTableData } from "@/server/tableData";
import { registerTableData, TableData } from "@/src/tableData";
import path, { dirname } from "path";
import fs from "fs";

export type PlotParams = { data: PlotData[] } & Omit<Plotly.PlotParams, "data">
export type Annotation = Partial<Annotations>

export type Props = {
    params: PlotParams
    tableData: TableData
    projectedTotal: number
}

async function getProjectedTotal(db: AsyncDuckDB) {
    const projectedCsvPath = path.join(dirname(process.cwd()), "data/njsp/projected.csv")
    const projectedCsvText = fs.readFileSync(projectedCsvPath).toString()
    const name = "projected.csv"
    await db.registerFileText(name, projectedCsvText)
    const [{ projectedTotal }] = await runQuery<{ projectedTotal: number }>(
        db,
        `select cast(sum(driver + pedestrian + passenger + cyclist) as integer) as projectedTotal from ${name}`
    )
    console.log("projectedTotal:", projectedTotal)
    return projectedTotal
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

async function getPlotData({ db, target, projectedTotal, initialPlotData }: {
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

export const getStaticProps: GetStaticProps<Props> = async () => {
    const initialPlot = loadPlot(njspPlotSpec) as PlotParams   // TODO: push cast into loadPlot
    const {
        data: initialPlotData,
        layout,
        ...plotRest
    } = initialPlot
    const db = await initDuckDb()
    const projectedTotal = await getProjectedTotal(db)
    // const crashesBase64 = loadParquetBase64("data/crashes.pqt")
    const tableData: TableData = loadTableData({ fmt: 'csv', stem: "data/njsp/year-type-county" })
    const target = await registerTableData({ db, tableData, stem: "ytc", })
    const { data, annotations } = await getPlotData({
        db,
        target,
        projectedTotal,
        initialPlotData,
    })

    return {
        props: {
            params: { data, layout: { ...layout, annotations }, ...plotRest },
            tableData,
            projectedTotal,
        },
    }
}

const title = "New Jersey Car Crash Deaths"

export default function Page(
    {
        params,
        tableData,
        projectedTotal,
    }: Props
) {
    // console.log("ytc:", ytc)
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
    // console.log("plot:", params)
    return (
        <div className={css.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />

            <main className={css.main}>
                <h1 className={css.title}>{title}</h1>
                <p>
                    Data comes from <A
                        title={"NJ State Police fatal crash data"}
                        href={"https://nj.gov/njsp/info/fatalacc/"}>
                        NJ State Police
                    </A>, and is updated daily (though crashes sometimes take weeks or months to show up).
                </p>
                <div className={css["plot-container"]}>
                    <PlotWrapper
                        params={{ data: data, layout: { ...layout, annotations }, ...plotRest }}
                        src={src}
                        alt={title}
                        // margin={{b: 30,}}
                    />
                    <hr/>
                </div>
                <p>Code and data are <A href={GitHub.href}>on GitHub</A>; feedback / issues <A href={`${GitHub.href}/issues/new`}>here</A>).</p>
                <Socials
                    socials={[
                        GitHub,
                        // { name: "NJSP", title: "NJ State Police fatal crash data", href: "https://nj.gov/njsp/info/fatalacc/", src: `/njsp.png`, },
                        // { name: "NJDOT", title: "NJ DOT raw crash data", href: "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm", src: `/njdot-s.png`, },
                        {
                            name: "Hudson County Complete Streets",
                            title: "Hudson County Complete Streets",
                            href: "https://hudcostreets.org",
                            src: `/logos/hccs.png`,
                        },
                    ]}
                />
            </main>
        </div>
    )
}
