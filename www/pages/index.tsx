import React, {Fragment, useState} from 'react'
import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import styles from '../styles/Home.module.css'
import path from "path";
import * as fs from "fs";
import dynamic from "next/dynamic";
import {PlotParams} from 'react-plotly.js';
import A from "next-utils/a";
import {Nav} from "next-utils/nav";
import Image from "next/image"
import index from "./index.module.css"
import {getBasePath} from "next-utils/basePath"
import {Socials} from "next-utils/socials"
import {GitHub, url} from "../src/socials"
import {plotSpecs, Plot, HasTotals, ProjectedTotals} from "../src/plotSpecs";
const { fromEntries } = Object
const Plotly = dynamic(() => import("react-plotly.js"), { ssr: false })

type PlotsDict = { [k: string]: { title: string, plot: PlotParams } }
type Props = { plotsDict: PlotsDict, rundate: string, } & HasTotals

export const getStaticProps: GetStaticProps = async () => {
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
    const plotTitleText = typeof plotTitle == 'string' ? plotTitle : plotTitle?.text
    const renderedSubtitle = subtitle instanceof Function ? subtitle({ title: plotTitleText, projectedTotals, rundate }) : subtitle
    const renderedChildren = children instanceof Function ? children({ title: plotTitleText, projectedTotals, rundate }) : children
    const height = style?.height || 450
    return (
        <div id={id} key={id} className={styles["plot-body"]}>
            <h2><a href={`#${id}`}>{title}</a></h2>
            {renderedSubtitle}
                <Plotly
                    onInitialized={() => { setInitialized(true) }}
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
                        alt={title}
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
    const basePath = getBasePath()

    const plots: Plot[] = plotSpecs.map(
        ({ name, src, ...rest }) => {
            const { title, plot } = plotsDict[name]
            return ({ name: name, src: src || `plots/${name}.png`, title, plot, ...rest } as Plot)
        }
    )
    const sections = plots.map(({ id, title, menuName, dropdownSection, }) => ({ id, name: menuName || title, dropdownSection: dropdownSection }))
    const menus = [
        { id: "NJSP", name: "NJSP", },
        { id: "state-years", name: "State x Years", },
        { id: "county-years", name: "Counties x Years", },
        { id: "state-months", name: "State x Months", },
        { id: "county-months", name: "Counties x Months", },
    ].map(s => ({
        ...s,
        sections: sections.filter(({ dropdownSection }) => s.name == dropdownSection)
    }))

    const title = "NJ Traffic Crash Data"
    return (
        <div className={styles.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
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
                    The NJ State Police <A title={"NJ State Police fatal crash data"} href={"https://nj.gov/njsp/info/fatalacc/"}>publish fatal crash data</A> going back to 2008. {"It's usually current to the previous day, though things also show up weeks or months after the fact. The first 5 plots below are from that data."}
                </p>
                <p>
                    <a href={"#njdot"}>Below that</a> is some analysis of <A title={"NJ DOT raw crash data"} href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}>NJ DOT raw crash data</A>, which includes property-damage, injury, and fatal crashes from 2001-2020 (≈6MM records). {`It's a richer dataset, but less up to date (it currently ends in 2020, just before things regressed dramatically in 2021). 2021 data should arrive in early 2023.`}
                </p>
                <p>{`Tap plots to see specific values, single- or double-tap legend entries to toggle or "solo" them.`}</p>
                <p>Code and cleaned data are on GitHub <A href={GitHub.href}>here</A>.</p>
                {
                    plots.map(
                        ({ id, ...rest }, idx) => (<Fragment key={id}>
                            {
                                idx == menus[0].sections.length && <>
                                    <h1 id={"njdot"}><a href={`#njdot`}>NJ DOT Raw Crash Data</a></h1>
                                    <p>
                                        NJ DOT <A title={"NJ DOT raw crash data"} href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}>publishes raw crash data</A>, including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records).
                                    </p>
                                    <p>{"The data currently ends in 2020, after a drop in all types of crashes due to COVID, and just before a spike in all crash types in 2021 and 2022 (based on the NJSP data above, and other sources). 2021 data should land in early 2023."}</p>
                                </>
                            }
                            <div key={id} className={styles["plot-container"]}>
                                <Plot id={id} basePath={basePath} rundate={rundate} {...rest} projectedTotals={projectedTotals} />
                                <hr/>
                            </div>
                        </Fragment>)
                    )
                }
                <p>Check out the code and data <A href={GitHub.href}>on GitHub</A> (or <A href={`${GitHub.href}/issues/new`}>leave some feedback</A>).</p>
                <Socials
                    socials={[
                        GitHub,
                        { name: "NJSP", title: "NJ State Police fatal crash data", href: "https://nj.gov/njsp/info/fatalacc/", src: `/njsp.png`, },
                        { name: "NJDOT", title: "NJ DOT raw crash data", href: "https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm", src: `/njdot-s.png`, },
                    ]}
                />
            </main>
        </div>
    )
}

export default Home
