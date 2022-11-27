import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import styles from '../styles/Home.module.css'
import React, {ReactNode} from 'react';
import path from "path";
import * as fs from "fs";
import dynamic from "next/dynamic";
const Plotly = dynamic(() => import("react-plotly.js"), { ssr: false, })
import {PlotParams} from 'react-plotly.js';
import {Font, Padding} from "plotly.js";
import A from "next-utils/a";
import {Nav} from "next-utils/nav";

type TitleObj = {
    text: string;
    font: Partial<Font>;
    xref: 'container' | 'paper';
    yref: 'container' | 'paper';
    x: number;
    y: number;
    xanchor: 'auto' | 'left' | 'center' | 'right';
    yanchor: 'auto' | 'top' | 'middle' | 'bottom';
    pad: Partial<Padding>
}
type Title = string | Partial<TitleObj>;

type PlotSpec = {
    id: string
    name: string
    title?: string  // taken from plot, by default
    subtitle?: ReactNode
    children?: ReactNode
}
type Plot = PlotSpec & {
    plot: PlotParams
    title: string
}
const plotSpecs: PlotSpec[] = [
    { id: "per-year", name: "fatalities_per_year_by_type", title: "NJ Traffic Fatalities per Year", subtitle: <p>2021 was the deadliest year on record; 2022 is on pace to exceed it</p>, children: <p>Victim types have been published since 2020</p> },
    { id: "per-month", name: "fatalities_per_month", },
    { id: "per-month-type", name: "fatalities_per_month_by_type", },
    // { id: "", name: "fatalities_by_month_lines", },
    { id: "by-month-bars", name: "fatalities_by_month_bars", title: "NJ Traffic Fatalities, grouped by month", },
]

type PlotsDict = { [k: string]: { title: string, plot: PlotParams } }
type Props = { plotsDict: PlotsDict }

const { fromEntries } = Object

export const getStaticProps: GetStaticProps = async (context) => {
    const plotsDirectory = path.join(process.cwd(), 'public', 'plots')
    const plotsDict = fromEntries(
        plotSpecs.map(({name, title, }) => {
            const plotPath = path.join(plotsDirectory, `${name}.json`)
            const plot = JSON.parse(fs.readFileSync(plotPath, 'utf8')) as PlotParams
            const plotTitle = title || (typeof plot.layout.title == 'string' ? plot.layout.title : plot.layout.title?.text)
            if (!plotTitle) {
                throw new Error(`No title found for plot ${name}`)
            }
            return [ name, { title: plotTitle, plot } ]
        })
    )
    return { props: { plotsDict }, }
}

function Plot({ id, title, subtitle, plot, children, }: Plot) {
    const {
        data,
        layout: {
            title: plotTitle, margin, legend, xaxis, yaxis,
            ...rest
        }
    } = plot
    if (xaxis) { /*xaxis.fixedrange = true ;*/ delete xaxis?.title }
    if (yaxis) { /*yaxis.fixedrange = true ;*/ delete yaxis?.title }
    return (
        <div id={id} key={id} className={styles["plot-body"]}>
            <h2><a href={`#${id}`}>{(typeof title === 'string') ? title : title?.text}</a></h2>
            {subtitle}
            <Plotly
                className={styles.plot}
                data={data}
                layout={{
                    margin: { t: 0, b: 10, l: 0, r: 25, },
                    legend: { orientation: "h", x: 0.5, xanchor: "center", yanchor: "top", itemwidth: 0, },
                    ...(xaxis ? { xaxis } : {}),
                    yaxis,
                    ...rest
                }}
                config={{ displayModeBar: false, }}
            />
            {children}
        </div>
    )
}

const Home = ({ plotsDict }: Props) => {
    // console.log("Home plots:", plotsDict)
    const plots: Plot[] = plotSpecs.map(
        ({ name, ...rest }) => {
            const { title, plot } = plotsDict[name]
            return ({ name: name, title, plot, ...rest } as Plot)
        }
    )

    const title = "NJ Fatal Traffic Crash Data"
    return (
        <div className={styles.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of data published by NJ State Police"}
                url={"https://neighbor-ryan.org/njsp"}
                thumbnail={""}  // TODO
            />

            <Nav
                id={"nav"}
                classes={"collapsed"}
                menus={plots.map(({ id, title }) => ({ id, name: title, }))}
            />

            <main className={styles.main}>
                <h1>{title}</h1>
                <p>Data: <A href={"https://nj.gov/njsp/info/fatalacc/"}>NJSP</A>, code: <A href={"https://github.com/neighbor-ryan/nj-fatal-crashes"}>GitHub</A></p>
                <hr/>
                {/*<ul className={styles.menu}>{*/}
                {/*    plots.map(({ id, title, }) => <li key={id}><a href={`#${id}`}>{title}</a></li>)*/}
                {/*}</ul>*/}
                <hr/>
                {
                    /*Object.entries(plots)*/
                    plots.map(
                        ({ id, ...rest }) => (
                            <div key={id} className={styles["plot-container"]}>
                                <Plot id={id} {...rest} />
                                <hr/>
                            </div>
                        )
                    )
                }
            </main>
        </div>
    )
}

export default Home
