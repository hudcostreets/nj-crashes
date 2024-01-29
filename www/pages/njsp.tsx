import React, { useEffect, useState } from 'react'
import type { GetStaticProps } from "next";
import { loadPlot } from "@rdub/next-plotly/plot-load";
import { njspPlotSpec } from "@/src/plotSpecs";
import css from "@/pages/index.module.scss";
import { Head } from "@rdub/next-base/head";
import { GitHub, url } from "@/src/socials";
import A from "@rdub/next-base/a";
import { Socials } from "@rdub/next-base/socials";
import { PlotParams } from "react-plotly.js";
import PlotWrapper from "@rdub/next-plotly/plot-wrapper";
import { initDuckDb, runQuery } from "@rdub/duckdb/duckdb";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import path, { dirname } from "path"
import fs from "fs";
import type { PlotData } from "plotly.js";

export type CsvData = {
    kind: 'csv'
    data: string
}
export type PqtData = {
    kind: 'pqt'
    base64: string
}
export type TableData = CsvData | PqtData

export type Props = {
    params: PlotParams
    tableData: TableData
}

function loadParquetBase64(relpath: string) {
    const absPath = path.join(dirname(process.cwd()), relpath)
    const pqtBuf = fs.readFileSync(absPath)
    const base64 = pqtBuf.toString('base64')
    return base64
}

export const getStaticProps: GetStaticProps<Props> = async () => {
    const dataFmt = 'csv'
    const params: PlotParams = loadPlot(njspPlotSpec)
    // const crashesBase64 = loadParquetBase64("data/crashes.pqt")
    let tableData: TableData
    if (dataFmt === 'csv') {
        const csvPath = path.join(dirname(process.cwd()), "data", "njsp", "year-type-county.csv")
        const data = fs.readFileSync(csvPath).toString()
        tableData = { kind: 'csv', data, }
    } else {
        const base64 = loadParquetBase64("data/njsp/year-type-county.pqt")  // TODO: this isn't checked into Git yet
        tableData = { kind: 'pqt',  base64, }
    }
    return {
        props: {
            params,
            tableData,
        },
    }
}

export type YtcRow = {
    year: number
    driver: number
    pedestrian: number
    cyclist: number
    passenger: number
}

const title = "New Jersey Car Crash Deaths"

export default function Page(
    {
        params,
        tableData,
    }: Props
) {
    // console.log("ytc:", ytc)
    const spec = njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ db, setDb ] = useState<AsyncDuckDB | null>(null)
    const [ data, setData ] = useState<any[] | null>(null)
    const { data: initialPlotData, ...plotRest } = params as { data: PlotData[] } & Omit<PlotParams, "data">
    const [ plotData, setPlotData ] = useState<PlotData[] | null>(null/*initialPlotData as PlotData[]*/)
    useEffect(
        () => {
            async function init() {
                const db = await initDuckDb()
                console.log("got db:", db)
                setDb(db)
                let target: string
                if (tableData.kind === 'csv') {
                    const path = "ytc.csv"
                    target = `'${path}'`
                    await db.registerFileText(path, tableData.data)
                } else {
                    const path = "ytc.parquet"
                    target = `parquet_scan('${path}')`
                    let ytcPqtArr = new Uint8Array(Buffer.from(tableData.base64, 'base64'))
                    await db.registerFileBuffer(path, ytcPqtArr)
                }
                console.log("registered file")
                let query: string
                query = `
                    SELECT 
                        year,
                        CAST(sum(driver) as INTEGER) as driver,
                        CAST(sum(pedestrian) as INTEGER) as pedestrian,
                        CAST(sum(cyclist) as INTEGER) as cyclist,
                        CAST(sum(passenger) as INTEGER) as passenger
                    FROM ${target}
                    GROUP BY year
                `
                const data = await runQuery<YtcRow>(db, query)
                console.log("got ytc data:", data)
                setData(data)
                const typesMap: { [k: string]: keyof YtcRow } = {
                    "Drivers": "driver",
                    "Pedestrians": "pedestrian",
                    "Cyclists": "cyclist",
                    "Passengers": "passenger",
                }
                const newPlotData = initialPlotData.map(series => {
                    const type = typesMap[series.name]
                    const newSeries: PlotData = { ...series }
                    newSeries.x = data.map(r => r.year)
                    newSeries.y = data.map(r => r[type])
                    return newSeries
                })
                console.log("newPlotData:", newPlotData)
                setPlotData(newPlotData)
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
                    {
                        plotData &&
                        <PlotWrapper
                            params={{ data: plotData, ...plotRest }}
                            src={src}
                            alt={title}
                            // margin={{b: 30,}}
                        />
                    }
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
