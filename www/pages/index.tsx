import React, { Fragment, useState } from 'react'
import type { GetStaticProps } from 'next'
import Head from '@rdub/next-base/head'
import css from './index.module.scss'
import A from "@rdub/next-base/a";
import { Nav } from "@rdub/next-base/nav";
import getBasePath from "@rdub/next-base/basePath"
import { url } from "@/src/site";
import { GitHub } from "@/src/socials"
import { plotSpecs } from "@/src/plotSpecs";
import { buildPlot, buildPlots, Plot, PlotsDict } from "@rdub/next-plotly/plot";
import { loadPlots } from "@rdub/next-plotly/plot-load";
import * as Njsp from "@/src/njsp/plot";
import { NjspPlot, PlotParams } from "@/src/njsp/plot";
import { getUrls, NjdotRawData, NjspFatalAcc, Urls } from "@/src/urls";
import Footer from '@/src/footer';
import { ResultTable } from "@/src/result-table";
import { EndYear, H2 } from "@/pages/c";
import { usePaginationControls } from "@/src/pagination";
import { useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import { cc2mc2mn, Counties } from "@/server/county";
import { CC2MC2MN } from "@/src/county";
import { NjspSource } from "@/src/icons";
import { getCrashes, getTotals } from "@/server/njsp/sql";
import { right } from "fp-ts/Either";
import { useQuery } from "@tanstack/react-query";
import { loadProps } from "@/server/njsp/plot";
import { useDb } from "@rdub/duckdb-wasm/duckdb";

type Props = {
    plotsDict: PlotsDict<PlotParams>
    njspProps: Njsp.Props
    urls: Urls
    cc2mc2mn: CC2MC2MN
    Counties: string[]
}

export const getStaticProps: GetStaticProps = async () => {
    const plotsDict: PlotsDict = loadPlots(plotSpecs)
    const urls = getUrls()
    const localUrls = getUrls({ local: true })
    const cc = null, mc = null, page = 0, perPage = 10
    const crashes = await getCrashes({ urls: localUrls, cc, mc, page, perPage, })
    const totals = await getTotals({ urls: localUrls, cc, mc, })
    return { props: { plotsDict, urls, cc2mc2mn, crashes, totals, Counties, }, }
}

const Home = ({ plotsDict, urls, cc2mc2mn, Counties, }: Props) => {
    const basePath = getBasePath()
    const [ requestChunkSize ] = useState<number>(64 * 1024)

    const [ njspPlotSpec, ...plotSpecs2 ] = plotSpecs
    const njspPlot = buildPlot<string, PlotParams>(njspPlotSpec, plotsDict[njspPlotSpec.id])
    const plots: Plot[] = buildPlots(plotSpecs2, plotsDict)
    const sections = [
        njspPlot,
        {
            id: "recent-fatal-crashes",
            title: "Recent Fatal Crashes",
            dropdownSection: "NJSP",
        } as Plot,
        ...plots
    ].map(({id, title, menuName, dropdownSection,}) => ({id, name: menuName || title, dropdownSection}))
    const menus = [
        { id: "NJSP", name: "NJSP", },
        { id: "state-years", name: "State x Years", },
        { id: "county-years", name: "Counties x Years", },
        { id: "state-months", name: "State x Months", },
        { id: "county-months", name: "Counties x Months", },
    ].map(s => ({
        ...s,
        sections: sections.filter(({dropdownSection}) => s.name == dropdownSection)
    }))
    const title = "NJ Traffic Crash Data"

    const [ county, setCounty ] = useState<string | null>(null)
    const dbc = useDb()
    const { data: njspProps } = useQuery({
        queryKey: [ "njspProps", county, dbc === null, ],
        refetchOnWindowFocus: false,
        refetchInterval: false,
        queryFn: async () => {
            if (!dbc) return null
            const { db, conn } = dbc
            return loadProps({ db, conn, county, Counties, })
        }
    })

    const cc = null, mc = null
    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = useNjspCrashRows({ urls, cc, mc, cn: county, cc2mc2mn, ...njspPaginationControls, }) ?? []
    const njspCrashesTotal = useNjspCrashesTotal({ urls, cc, mc, requestChunkSize, })
    const njspPagination = { ...njspPaginationControls, total: njspCrashesTotal?.total ?? 0 }

    return (
        <div className={css.container}>
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
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"/>
            </Nav>

            <main className={css.index}>
                <h1 className={css.title}>{title}</h1>
                <p>
                    <A href={`#per-year`}>The first {menus[0].sections.length} plots below</A> come from <A title={"NJ State Police fatal crash data"} href={NjspFatalAcc}>NJ State Police fatal crash data</A> (2008-present). {"It's generally current to the previous day."}
                </p>
                <p>
                    <A href={"#njdot"}>Below that</A> are plots of <A title={"NJ DOT raw crash data"} href={NjdotRawData}>NJ DOT raw crash data</A>, which includes 6MM property-damage, injury, and fatal crashes from 2001-{EndYear}. {`It's a richer dataset, but less up to date.`}
                </p>
                <p>
                    <span className={css.bold}>Work in progress</span> map of NJDOT data: 5 years (2017-2021) of fatal
                    and injury crashes in Hudson County:
                </p>
                <iframe src={`${basePath}/map/hudson`} className={css.map} />
                <ul style={{listStyle: "none"}}>
                    <li><A href={"/map/hudson"}>Full screen map here</A></li>
                    <li>Code and cleaned data are <A href={GitHub.href}>here on GitHub</A>.</li>
                </ul>
                <div className={css["plot-container"]}>
                    {
                        njspProps
                          ? <NjspPlot
                            {...njspProps}
                            county={county}
                            setCounty={setCounty}
                            includeMoreInfoLink={true}
                          />
                          : null
                    }
                    <hr/>
                </div>
                {
                    <div className={css["plot-container"]}>
                        <div className={css.section}>
                            <H2 id={"recent-fatal-crashes"}>Recent fatal crashes</H2>
                            {
                                njspCrashes && <ResultTable
                                    result={right(njspCrashes)}
                                    pagination={njspPagination}
                                />
                            }
                            <NjspSource />
                        </div>
                        <hr/>
                    </div>
                }
                {
                    plots.map(
                        ({id, ...rest}, idx) =>
                            <Fragment key={id}>
                                {
                                    // First 2 NJSP "plots" already inlined above
                                    idx + 2 == menus[0].sections.length && <>
                                        <h1 id={"njdot"}><a href={`#njdot`}>NJ DOT Raw Crash Data</a></h1>
                                        <p>
                                            NJ DOT <A title={"NJ DOT raw crash data"}
                                                      href={"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm"}>publishes
                                            raw crash data</A>, including property-damage, injury, and fatal crashes, going
                                            back to 2001 (≈6MM records).
                                        </p>
                                        <p>{`Data is currently public through ${EndYear}, showing all crash types rebounding from COVID lows, and a particular spike in fatalities. 2023 data is expected in Fall 2025.`}</p>
                                    </>
                                }
                                <div key={id} className={css["plot-container"]}>
                                    <Plot
                                        id={id}
                                        basePath={basePath}
                                        {...rest}
                                        margin={{ t: 10, b: 30, }}
                                    />
                                    <hr/>
                                </div>
                            </Fragment>
                    )
                }
                <Footer />
            </main>
        </div>
    )
}

export default Home
