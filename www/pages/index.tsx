import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import styles from '../styles/Home.module.css'
import React, {ReactNode} from 'react';
import path from "path";
import * as fs from "fs";
import dynamic from "next/dynamic";
const Plotly = dynamic(() => import("react-plotly.js"), { ssr: false, })
import {PlotParams} from 'react-plotly.js';
import {Font, Legend, Padding} from "plotly.js";
import A from "next-utils/a";
import {Menu, Nav} from "next-utils/nav";

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

function extractDataDate({title}: { title: string }) {
    const regex = /.*Data ca\. (\d{4}-\d\d-\d\d).*/
    const match = regex.exec(title)
    if (!match) {
        throw new Error(`No data date found: ${title}`)
    }
    return match[1]
}

type NodeFn = ReactNode | (({ title }: { title?: string } & HasTotals) => ReactNode)
type PlotSpec = {
    id: string
    name: string
    title?: string  // taken from plot, by default
    style?: React.CSSProperties
    legend?: "inherit" | Legend
    subtitle?: NodeFn
    children?: NodeFn
}
type Plot = PlotSpec & {
    plot: PlotParams
    title: string
}

const EMPTY: PlotSpec[] = []
const SC_MY_IPD_SPECS: PlotSpec[] =
    EMPTY.concat(...['m', 'y'].map(my =>
        EMPTY.concat(...['s', 'c'].map(sc =>
            EMPTY.concat(...['i', 'p', 'd'].map(t => {
                const id = `${t}${sc}${my}`
                const name = `njdot/${id}`
                const region = { 's': 'State', 'c': 'County' }[sc]
                const freq = { 'y': 'Year', 'm': 'Month' }[my]
                const type = { 'i': 'Injuries', 'p': 'Property Damage Crashes', 'd': 'Deaths' }[t]
                let title = region == 'State' ? `${type} per ${freq} (Statewide)` : `${type} per {${region}, ${freq}}`
                if (id == 'dcm') {
                    title += ` (12mo avgs)`
                }
                return { id, name, title, style: region == 'County' && { height: 580 }/*, legend: "inherit"*/, } as PlotSpec
            }))
        ))
    ))

const plotSpecs: PlotSpec[] = [
    {
        id: "per-year", name: "fatalities_per_year_by_type", title: "NJ Traffic Fatalities per Year",
        subtitle: ({ title, projectedTotals }: { title: string } & HasTotals) => {
            const total2021 = projectedTotals["2021"]["Projected Total"]
            const total2022 = projectedTotals["2022"]["Projected Total"]
            if (total2022 > total2021) {
                return <>
                    <p>2021 was the deadliest year on record, with {total2021} deaths.</p>
                    <p>As of {extractDataDate({title})}, 2022 is on pace to exceed it, with {total2022}.</p>
                </>
            } else {
                return <>
                    <p>2021 was the deadliest year on record, with {total2021} deaths.</p>
                    <p>As of {extractDataDate({title})}, 2022 is on pace for {total2022}.</p>
                </>
            }
        },
        children: <p>Victim types have been published since 2020.</p>,
    },
    { id: "per-month", name: "fatalities_per_month", },
    { id: "per-month-type", name: "fatalities_per_month_by_type", },
    // { id: "", name: "fatalities_by_month_lines", },
    { id: "by-month-bars", name: "fatalities_by_month_bars", title: "NJ Traffic Deaths, grouped by month", },
    ...SC_MY_IPD_SPECS
]

type PlotsDict = { [k: string]: { title: string, plot: PlotParams } }
type Year = "2021" | "2022"
type YearTotals = { "Projected Total": number }
type ProjectedTotals = { [k in Year]: YearTotals }
type HasTotals = { projectedTotals: ProjectedTotals }

type Props = { plotsDict: PlotsDict } & HasTotals

const { fromEntries } = Object

export const getStaticProps: GetStaticProps = async (context) => {
    const plotsDirectory = path.join(process.cwd(), 'public', 'plots')
    const plotsDict = fromEntries(
        plotSpecs.map(({name, title, style, legend }) => {
            const plotPath = path.join(plotsDirectory, `${name}.json`)
            const plot = JSON.parse(fs.readFileSync(plotPath, 'utf8')) as PlotParams
            if (style) {
                plot.style = style
            }
            if (legend == "inherit") {
                // pass
            } else if (legend) {
                plot.layout.legend = legend
            } else {
                plot.layout.legend = { orientation: "h", x: 0.5, xanchor: "center", yanchor: "top", itemwidth: 0, }
            }
            const plotTitle = title || (typeof plot.layout.title == 'string' ? plot.layout.title : plot.layout.title?.text)
            if (!plotTitle) {
                throw new Error(`No title found for plot ${name}`)
            }
            return [ name, { title: plotTitle, plot } ]
        })
    )
    const projectedTotalsPath = path.join(plotsDirectory, `projected_totals.json`)
    const projectedTotals = JSON.parse(fs.readFileSync(projectedTotalsPath, 'utf8')) as ProjectedTotals
    return { props: { plotsDict, projectedTotals }, }
}

function Plot({ id, title, subtitle, plot, children, projectedTotals }: Plot & HasTotals) {
    const {
        data,
        layout: {
            title: plotTitle, margin, xaxis, yaxis,
            ...rest
        },
        style
    } = plot
    if (xaxis) { /*xaxis.fixedrange = true ;*/ delete xaxis?.title }
    if (yaxis) { /*yaxis.fixedrange = true ;*/ delete yaxis?.title }
    const plotTitleText = typeof plotTitle == 'string' ? plotTitle : plotTitle?.text
    const renderedSubtitle = subtitle instanceof Function ? subtitle({ title: plotTitleText, projectedTotals }) : subtitle
    const renderedChildren = children instanceof Function ? children({ title: plotTitleText, projectedTotals }) : children
    return (
        <div id={id} key={id} className={styles["plot-body"]}>
            <h2><a href={`#${id}`}>{title}</a></h2>
            {renderedSubtitle}
            <Plotly
                className={styles.plot}
                data={data}
                layout={{
                    margin: { t: 0, b: 30, l: 0, r: 25, },
                    ...(xaxis ? { xaxis } : {}),
                    yaxis,
                    dragmode: false,
                    ...rest
                }}
                config={{ displayModeBar: false, scrollZoom: false, }}
                style={style}
            />
            {renderedChildren}
        </div>
    )
}

const Home = ({ plotsDict, projectedTotals }: Props) => {
    // console.log("Home plots:", plotsDict)
    const plots: Plot[] = plotSpecs.map(
        ({ name, ...rest }) => {
            const { title, plot } = plotsDict[name]
            return ({ name: name, title, plot, ...rest } as Plot)
        }
    )
    const sections = plots.map(({ id, title }) => ({ id, name: title, }))
    const menus = [
        { id: "NJSP", name: "NJSP", sections: sections.slice(0, 4) },
        { id: "state-months", name: "State x Months", sections: sections.slice(4, 7) },
        { id: "county-months", name: "Counties x Months", sections: sections.slice(7, 10) },
        { id: "state-years", name: "State x Years", sections: sections.slice(10, 13) },
        { id: "county-years", name: "Counties x Years", sections: sections.slice(13, 16) },
    ]

    const title = "NJ Fatal Traffic Crash Data"
    const url = "https://neighbor-ryan.org/nj-fatal-crashes"
    return (
        <div className={styles.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of data published by NJ State Police"}
                url={url}
                thumbnail={`${url}/fatalities_per_year_by_type.png`}
            />

            <Nav
                id={"nav"}
                classes={"collapsed"}
                menus={menus}
                hover={false}
            >
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css" />
            </Nav>

            <main className={styles.main}>
                <h1>{title}</h1>
                <p>Data: <A href={"https://nj.gov/njsp/info/fatalacc/"}>NJSP</A>, code: <A href={"https://github.com/neighbor-ryan/nj-fatal-crashes"}>GitHub</A></p>
                {
                    plots.map(
                        ({ id, ...rest }) => (
                            <div key={id} className={styles["plot-container"]}>
                                <Plot id={id} {...rest} projectedTotals={projectedTotals} />
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
