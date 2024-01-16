import React, { useEffect, useState } from 'react'
import type { GetStaticProps } from "next";
import { loadSync } from "next-utils/load";
import { loadPlot } from "next-utils/plot-load";
import { HasTotals, njspPlotSpec, ProjectedTotals } from "@/src/plotSpecs";
import css from "@/pages/index.module.scss";
import { Head } from "next-utils/head";
import { GitHub, url } from "@/src/socials";
import A from "next-utils/a";
import { Socials } from "next-utils/socials";
import { PlotParams } from "react-plotly.js";
import PlotWrapper from "next-utils/plot-wrapper";
import { initDuckDb, runQuery } from "next-utils/parquet";
import { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import path, { dirname } from "path"
import fs from "fs";

// type Props = { params: PlotParams, rundate: string, } & HasTotals
export type Props = {
    params: PlotParams
    // crashesPqtArr: number[]
    crashesBase64: string
    // ytcCsvStr: string
    ytc: any[]
}

export const getStaticProps: GetStaticProps<Props> = async () => {
    // const { rundate } = loadSync<{ rundate: string }>(`public/rundate.json`)
    // console.log(`rundate: ${rundate}`)
    // const projectedTotals = loadSync<ProjectedTotals>(`public/plots/projected_totals.json`)
    const params: PlotParams = loadPlot(njspPlotSpec)
    const crashesPqtPath = path.join(dirname(process.cwd()), "data", "crashes.pqt")
    const crashesPqtBuf = fs.readFileSync(crashesPqtPath)
    const crashesBase64 = crashesPqtBuf.toString('base64') //btoa(crashesPqtArr)//String.fromCharCode.apply(null, crashesPqtArr))
    // console.log("crashesBase64:", crashesBase64.substring(0, 100))

    const ytcCsvPath = path.join(dirname(process.cwd()), "data", "njsp", "year-type-county.csv")
    const ytcCsvStr = fs.readFileSync(ytcCsvPath).toString()
    const db = await initDuckDb()
    await db.registerFileBuffer(
        'ytc.csv',
        Uint8Array.from(Buffer.from(ytcCsvStr)),
    )
    const ytc = await runQuery(db, `SELECT * FROM read_csv_auto('ytc.csv')`) as any[]
    // const ytc = [] as any[]
    return {
        props: {
            params,
            crashesBase64,
            // ytcCsvStr,
            ytc,
            /*projectedTotals, rundate,*/
        },
    }
}

const title = "New Jersey Car Crash Deaths"

export default function Page({ params, crashesBase64, ytc, /*projectedTotals, rundate,*/ }: Props) {
    console.log("ytc:", ytc)
    const spec = njspPlotSpec
    let { src, name } = spec
    src = src ?? `plots/${name}.png`
    const [ db, setDb ] = useState<AsyncDuckDB | null>(null)
    const csvUrl = "https://raw.githubusercontent.com/neighbor-ryan/nj-crashes/main/data/njsp/year-type-county.csv"
    const [ data, setData ] = useState<any[] | null>(null)
    useEffect(
        () => {
            async function init() {
                const db = await initDuckDb()
                let crashesPqtArr = new Uint8Array(Buffer.from(crashesBase64, 'base64'))
                console.log("got db:", db)
                await db.registerFileBuffer(
                    'crashes.parquet',
                    crashesPqtArr,
                    // Uint8Array.from(crashesPqtArr)
                )
                console.log("registered file")
                const query = `SELECT count(*) FROM parquet_scan('crashes.parquet')`
                const [countRes] = await runQuery(db, query)
                console.log("countRes:", countRes)
            }
            init()
            // initDuckDb(/*{ path:  }*/).then(
            //     db => {
            //         console.log("got db:", db)
            //         setDb(db)
            //
            //         const query = `CREATE TABLE ytc AS SELECT * from read_csv_auto('${csvUrl}')`
            //         return runQuery(db, query).then(res => {
            //             console.log("made table:", res)
            //             return runQuery(db, `SELECT * FROM ytc`)
            //         }).then(data => {
            //             console.log("got data:", data)
            //             setData(data)
            //         })
            //     }
            // )
        },
        [ crashesBase64, ]
    )
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
                        params={params}
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
