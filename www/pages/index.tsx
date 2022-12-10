import React, {Fragment, ReactNode, useState} from 'react'
import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import styles from '../styles/Home.module.css'
import path from "path";
import * as fs from "fs";
import dynamic from "next/dynamic";
import {PlotParams} from 'react-plotly.js';
import {Legend} from "plotly.js";
import A from "next-utils/a";
import {Nav} from "next-utils/nav";
import getConfig from "next/config";
import Image from "next/image"
import index from "./index.module.css"

const Plotly = dynamic(() => import("react-plotly.js"), { ssr: false })

const GitHub = 'https://github.com/neighbor-ryan/nj-crashes'

type NodeFn = ReactNode | (({ title, rundate }: { title?: string, rundate: string } & HasTotals) => ReactNode)
type PlotSpec = {
    id: string
    name: string
    menuName?: string
    dropdownSection?: string,
    title?: string  // taken from plot, by default
    style?: React.CSSProperties
    legend?: "inherit" | Legend
    src?: string
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
                const section = `${{ 's': 'State', 'c': 'Counties' }[sc]} x ${freq}s`
                const type = { 'i': 'Injuries', 'p': 'Property Damage Crashes', 'd': 'Deaths' }[t]
                const menuName = { 'i': 'Injuries', 'p': 'Property Damage', 'd': 'Deaths' }[t]
                let title = region == 'State' ? `${type} per ${freq} (Statewide)` : `${type} per {${region}, ${freq}}`
                if (id == 'dcm') {
                    title += ` (12mo avgs)`
                }
                return {
                    id, name, title, menuName, dropdownSection: section,
                    style: region == 'County' && { height: 580 },
                    /*, legend: "inherit",*/
                } as PlotSpec
            }))
        ))
    ))

const plotSpecs: PlotSpec[] = [
    {
        id: "per-year", name: "fatalities_per_year_by_type", title: "NJ Traffic Deaths per Year", menuName: "Traffic Deaths / Year", dropdownSection: "NJSP",
        children: ({ rundate, projectedTotals }: { rundate: string, } & HasTotals) => {
            const total2021 = projectedTotals["2021"]["Projected Total"]
            const total2022 = projectedTotals["2022"]["Projected Total"]
            const shortDate = new Date(rundate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: 'UTC' })
            return <>
                <p>2021 was the worst year in the NJSP dataset (since 2008), with {total2021} deaths.</p>
                <p><A href={`${GitHub}/commits/main`}>As of {shortDate}</A>, 2022 is on pace {total2022 > total2021 ? `to exceed it, with` : `for`} {total2022}.</p>
                <p>Victim types have been published since 2020.</p>
            </>
        },
    },
    {
        id: "vs-homicides", name: "crash_homicide_cmp", title: "NJ Traffic Deaths vs. Homicides", menuName: "Traffic Deaths vs. Homicides", dropdownSection: "NJSP",
        children: <>
            <p>Traffic crashes kill 1.5-2x as many people as homicides in NJ.</p>
            <p>Homicide data comes from <A href={"https://nj.gov/njsp/ucr/uniform-crime-reports.shtml"}>NJ State Police</A> and <A href={"https://www.disastercenter.com/crime/njcrimn.htm"}>Disaster Center</A>.</p>
        </>
    },
    { id: "per-month", name: "fatalities_per_month", title: "NJ Traffic Deaths per Month", menuName: "Traffic Deaths / Month", dropdownSection: "NJSP", },
    { id: "per-month-type", name: "fatalities_per_month_by_type", title: "NJ Traffic Deaths per Month (by Victim Type)", menuName: "By Victim Type", dropdownSection: "NJSP", },
    { id: "by-month-bars", name: "fatalities_by_month_bars", title: "NJ Traffic Deaths, grouped by month", menuName: "Grouped by Month", dropdownSection: "NJSP", },
    ...SC_MY_IPD_SPECS,
]

type PlotsDict = { [k: string]: { title: string, plot: PlotParams } }
type Year = "2021" | "2022"
type YearTotals = { "Projected Total": number }
type ProjectedTotals = { [k in Year]: YearTotals }
type HasTotals = { projectedTotals: ProjectedTotals }

type Props = { plotsDict: PlotsDict, rundate: string, } & HasTotals

const { fromEntries } = Object

export const getStaticProps: GetStaticProps = async (context) => {
    const publicDirectory = path.join(process.cwd(), 'public')
    const rundatePath = path.join(publicDirectory, 'rundate.json')
    const rundate = JSON.parse(fs.readFileSync(rundatePath, 'utf8')).rundate
    console.log(`rundate: ${rundate}`)
    const plotsDirectory = path.join(publicDirectory, 'plots')
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
    return { props: { plotsDict, projectedTotals, rundate, }, }
}

function Plot({ id, title, subtitle, plot, basePath, rundate, src, children, projectedTotals }: Plot & HasTotals & { basePath: string, rundate: string, }) {
    const [ initialized, setInitialized ] = useState(false)
    const {
        data,
        layout: {
            title: plotTitle, margin, xaxis, yaxis,
            ...rest
        },
        style
    } = plot
    // if (xaxis) { /*xaxis.fixedrange = true ;*/ delete xaxis?.title }
    // if (yaxis) { /*yaxis.fixedrange = true ;*/ delete yaxis?.title }
    const plotTitleText = typeof plotTitle == 'string' ? plotTitle : plotTitle?.text
    const renderedSubtitle = subtitle instanceof Function ? subtitle({ title: plotTitleText, projectedTotals, rundate }) : subtitle
    const renderedChildren = children instanceof Function ? children({ title: plotTitleText, projectedTotals, rundate }) : children
    const height = style?.height || 450
    return (
        <div id={id} key={id} className={styles["plot-body"]}>
            <h2><a href={`#${id}`}>{title}</a></h2>
            {renderedSubtitle}
                <Plotly
                    onInitialized={() => { console.log(`plot ${id} initialized`); setInitialized(true) }}
                    className={styles.plot}
                    data={data}
                    layout={{
                        margin: { t: 0, r: 25, b: 30, l: 0, },
                        ...(xaxis ? { xaxis } : {}),
                        yaxis,
                        autosize: true,
                        dragmode: false,
                        ...rest
                    }}
                    config={{ displayModeBar: false, scrollZoom: false, }}
                    style={{ ...style, display: initialized ? "" : "none", width: "100%" }}
                    // onClick={() => setInitialized(false)}
                />
            {
                src &&
                <div className={`${index.fallback} ${initialized ? index.hidden : ""}`} style={{ height: `${height}px`, maxHeight: `${height}px` }}>
                    <Image
                        src={`${basePath}/${src}`}
                        width={800} height={height}
                        // layout="responsive"
                        loading="lazy"
                        // onClick={() => setInitialized(true)}
                    />
                    <div className={index.spinner}></div>
                </div>
            }
            {renderedChildren}
        </div>
    )
}

const Home = ({ plotsDict, projectedTotals, rundate, }: Props) => {
    // console.log("Home plots:", plotsDict)
    const { publicRuntimeConfig: config } = getConfig()
    const { basePath = "" } = config

    const plots: Plot[] = plotSpecs.map(
        ({ name, src, ...rest }) => {
            const { title, plot } = plotsDict[name]
            return ({ name: name, src: src || `plots/${name}.png`, title, plot, ...rest } as Plot)
        }
    )
    const sections = plots.map(({ id, title, menuName, dropdownSection, }) => ({ id, name: menuName || title, dropdownSection: dropdownSection }))
    const menus = [
        { id: "NJSP", name: "NJSP", },
        { id: "state-months", name: "State x Months", },
        { id: "county-months", name: "Counties x Months", },
        { id: "state-years", name: "State x Years", },
        { id: "county-years", name: "Counties x Years", },
    ].map(s => ({
        ...s,
        sections: sections.filter(({ name, dropdownSection }) => s.name == dropdownSection)
    }))

    const title = "NJ Traffic Crash Data"
    const url = "https://neighbor-ryan.org/nj-crashes"
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
                <h1 className={index.title}>{title}</h1>
                <p>
                    The NJ State Police <A title={"NJ State Police fatal crash data"} href={"https://nj.gov/njsp/info/fatalacc/"}>publish fatal crash data</A> going back to 2008. {"It's usually current to the previous day, though things also show up weeks or months after the fact. The first 4 plots below are from that data."}
                </p>
                <p>
                    <a href={"#njdot"}>Below that</a> is some analysis of <A title={"NJ DOT raw crash data"} href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}>NJ DOT raw crash data</A>, which includes injury and property-damage crashes going back to 2001 (≈6MM records). {"It's released in annual tranches, ≈15mos after each year end (i.e. 2021 data should arrive in early 2023)."}
                </p>
                <p>
                    Code and cleaned data are on GitHub <A href={GitHub}>here</A>.
                </p>
                {
                    plots.map(
                        ({ id, ...rest }, idx) => (<Fragment key={id}>
                            {
                                idx == menus[0].sections.length && <>
                                    <h1 id={"njdot"}>NJ DOT Raw Crash Data</h1>
                                    <p>
                                        NJ DOT <A title={"NJ DOT raw crash data"} href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}>publishes raw crash data</A>, including injury and property-damage crashes, going back to 2001 (≈6MM records).
                                    </p>
                                    <p>{"It generally shows a downward trend over the last few decades, which is good, though it ends at 2020, just before we regressed by 10-15yrs (based on the NJSP data above). 2021 data should land in early 2023."}</p>
                                </>
                            }
                            <div key={id} className={styles["plot-container"]}>
                                <Plot id={id} basePath={basePath} rundate={rundate} {...rest} projectedTotals={projectedTotals} />
                                <hr/>
                            </div>
                        </Fragment>)
                    )
                }
                <p>Check out the code and data (or <A href={`${GitHub}/issues/new`}>leave some feedback</A>) <A href={GitHub}>on GitHub</A>.</p>
                <p>
                    <A title={"Source code and documentation on GitHub"} href={GitHub}><img alt={"GitHub Logo"} className={index.logo} src={`${basePath}/gh.png`} /></A>
                    {" "}
                    <A title={"NJ State Police fatal crash data"} href={"https://nj.gov/njsp/info/fatalacc/"}><img alt={"NJSP Logo"} className={index.logo} src={`${basePath}/njsp.png`}/></A>
                    {" "}
                    <A title={"NJ DOT raw crash data"} href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}><img alt={"NJ DOT Logo"} className={index.logo} src={`${basePath}/njdot-s.png`}/></A>
                </p>
            </main>
        </div>
    )
}

export default Home
