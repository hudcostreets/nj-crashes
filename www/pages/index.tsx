import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import styles from '../styles/Home.module.css'
import React from 'react';
import path from "path";
import * as fs from "fs";
import dynamic from "next/dynamic";
const Plot = dynamic(() => import("react-plotly.js"), { ssr: false, })
import {PlotParams} from 'react-plotly.js';

type Plots = { [k: string]: PlotParams }
export const getStaticProps: GetStaticProps = async (context) => {
    const plotsDirectory = path.join(process.cwd(), 'public', 'plots')
    const plot = "fatalities_by_month_bars"
    const plotPath = path.join(plotsDirectory, `${plot}.json`)
    const plotContents = JSON.parse(fs.readFileSync(plotPath, 'utf8')) as PlotParams

    const plots: Plots = {}
    plots[plot] = plotContents
    console.log("plots:", plots)
    return { props: { plots }, }
}

const Home = ({ plots }: { plots: Plots }) => {
    console.log("Home plots:", plots)
    return (
        <div className={styles.container}>
            <Head
                title={""}
                url={""}
                description={""}
                thumbnail={""}
            />

            <main className={styles.main}>
                <h1>NJ Fatal Traffic Crash Data </h1>
                {
                    Object.entries(plots).map(
                        ([
                            name,
                             {
                                 data,
                                 layout: {
                                     title, margin, legend, xaxis, yaxis,
                                     ...layout
                                 }
                             }
                         ]) => {
                            if (xaxis) { xaxis.fixedrange = true ; delete xaxis?.title }
                            if (yaxis) { yaxis.fixedrange = true ; delete yaxis?.title }
                            return (
                                <div key={name} className={styles["plot-container"]}>
                                    <h2>{(typeof title === 'string') ? title : title?.text}</h2>
                                    <Plot
                                        className={styles.plot}
                                        data={data}
                                        layout={{
                                            margin: { t: 0, b: 10, l: 0, r: 0, },
                                            legend: { orientation: "h", x: 0.5, xanchor: "center", yanchor: "top", itemwidth: 0, },
                                            xaxis,
                                            yaxis,
                                            ...layout
                                        }}
                                        config={{ displayModeBar: false, }}
                                    />
                                </div>
                            )
                        }
                    )
                }
            </main>
        </div>
    )
}

export default Home
