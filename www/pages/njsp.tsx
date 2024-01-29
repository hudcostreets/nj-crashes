import React, { useEffect, useState } from 'react'
import type { GetStaticProps } from "next";
import { loadSync } from "@rdub/base/load";
import { loadPlot } from "@rdub/next-plotly/plot-load";
import { HasTotals, njspPlotSpec, ProjectedTotals } from "@/src/plotSpecs";
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
import { fromEntries } from "@rdub/base/objs";

// type Props = { params: PlotParams, rundate: string, } & HasTotals
export type Props = {
    params: PlotParams
    // crashesPqtArr: number[]
    ytcBase64: string
    // crashesBase64: string
    // ytcCsvStr: string
    // ytc: any[]
}

function loadParquetBase64(relpath: string) {
    const absPath = path.join(dirname(process.cwd()), relpath)
    const pqtBuf = fs.readFileSync(absPath)
    const base64 = pqtBuf.toString('base64')
    return base64
}

export const getStaticProps: GetStaticProps<Props> = async () => {
    const params: PlotParams = loadPlot(njspPlotSpec)
    // const crashesBase64 = loadParquetBase64("data/crashes.pqt")

    const ytcBase64 = loadParquetBase64("data/njsp/year-type-county.pqt")
    console.log("ytcBase64:", ytcBase64.substring(0, 100))

    // const ytcCsvPath = path.join(dirname(process.cwd()), "data", "njsp", "year-type-county.csv")
    // const ytcCsvStr = fs.readFileSync(ytcCsvPath).toString()
    // const db = await initDuckDb()
    // await db.registerFileBuffer(
    //     'ytc.csv',
    //     Uint8Array.from(Buffer.from(ytcCsvStr)),
    // )
    // const ytc = await runQuery(db, `-- SELECT * FROM read_csv_auto('ytc.csv')`) as any[]
    // const ytc = [] as any[]
    return {
        props: {
            params,
            ytcBase64,
            // crashesBase64,
            // ytcCsvStr,
            // ytc,
            /*projectedTotals, rundate,*/
        },
    }
}

const title = "New Jersey Car Crash Deaths"

export default function Page({ params, ytcBase64, /*crashesBase64, projectedTotals, rundate,*/ }: Props) {
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
                // let crashesPqtArr = new Uint8Array(Buffer.from(crashesBase64, 'base64'))
                let ytcPqtArr = new Uint8Array(Buffer.from(ytcBase64, 'base64'))
                console.log("got db:", db)
                setDb(db)
                // await db.registerFileText(
                //     'ytc.json',
                //     JSON.stringify(ytc),
                // );
                const path = "crashes.parquet"
                await db.registerFileBuffer(path, ytcPqtArr)
                console.log("registered file")
                const conn = await db.connect()

                let query = `SELECT count(*) FROM parquet_scan('${path}')`
                const [countRes] = await runQuery(db, query)
                console.log("countRes:", countRes)
                query = `
                    SELECT 
                        year,
                        sum(driver) as driver,
                        sum(pedestrian) as pedestrian,
                        sum(cyclist) as cyclist,
                        sum(passenger) as passenger 
                    FROM parquet_scan('${path}')
                    GROUP BY year
                `
                const proxies = (await conn.query(query)).toArray()
                // const data = JSON.parse(JSON.stringify(proxies, (k, v) => {
                //     console.log("replacer:", k, v)
                //     return typeof v === 'bigint' ? v.toString() : v
                // })) as any[]
                const data = proxies.map(r => r.toJSON())
                for (const row of data) {
                    console.log("year:", row.year, "driver:", row.driver)
                    row.year = parseInt(row.year)
                    row.driver = parseInt(row.driver)
                    row.pedestrian = parseInt(row.pedestrian)
                    row.cyclist = parseInt(row.cyclist)
                    row.passenger = parseInt(row.passenger)
                }
                console.log("got ytc data:", data)
                setData(data)
                const typesMap: { [k: string]: string } = {
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
                // for (let type of [ "driver", "pedestrian", "cyclist", "passenger" ]) {
                //
                // }
                // let [ driverPlotData, ...otherPlotData ] = plotData
                // driverPlotData = { ...driverPlotData }
                // driverPlotData.x = data.map(r => r.year)
                // driverPlotData.y = data.map(r => r.driver)
                // const newPlotData = [ driverPlotData, ...otherPlotData ]
                console.log("newPlotData:", newPlotData)
                setPlotData(newPlotData)
                // query = `SELECT * FROM parquet_scan('${path}')`
                // const data = await runQuery(db, query)
            }
            init()
        },
        [ ytcBase64, ]
    )
    console.log("plot:", params)
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
