import React, { Fragment, useState } from 'react'
import type { GetServerSideProps } from 'next'
import Head from '@rdub/next-base/head'
import css from './index.module.scss'
import A from "@rdub/next-base/a";
import { Nav } from "@rdub/next-base/nav";
import { url } from "@/src/site";
import { GitHub } from "@/src/socials"
import { plotSpecs } from "@/src/plotSpecs";
import { buildPlot, buildPlots, Plot, PlotsDict } from "@rdub/next-plotly/plot";
import { loadPlots } from "@rdub/next-plotly/plot-load";
import { NjspPlot, PlotParams, Props as NjspProps } from "@/src/njsp/plot";
import { getUrls, NjdotRawData, NjspFatalAcc } from "@/src/urls";
import Footer from '@/src/footer';
import { ResultTable } from "@/src/result-table";
import { EndYear, H2 } from "@/pages/c/[[...region]]";
import { usePaginationControls } from "@/src/pagination";
import { getNjspCrashRows } from "@/src/use-njsp-crashes";
import { cc2mc2mn } from "@/server/county";
import { CC2MC2MN } from "@/src/county";
import { NjspSource } from "@/src/icons";
import { right } from "fp-ts/Either";
import { loadProps } from "@/server/njsp/plot";
import { Crash } from '@/src/njsp/crash';
import { Crashes } from '@/server/njsp/sql';

type Props = {
    plotsDict: PlotsDict<PlotParams>
    cc2mc2mn: CC2MC2MN
    njspProps: NjspProps
    crashes: Crash[]
    njspCrashesTotal: number
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
    const plotsDict = loadPlots(plotSpecs) as PlotsDict<PlotParams>
    const urls = getUrls({ local: true })
    const page = 0, perPage = 10, cc = null, mc = null
    const crashDb = new Crashes(urls.njsp.crashes)
    const [ crashes, njspCrashesTotal, njspProps, ] = await Promise.all([
        crashDb.crashes({ cc, mc, page, perPage, }),
        crashDb.total({ cc, mc, }),
        loadProps({ county: null }),
    ])
    return { props: { plotsDict, cc2mc2mn, njspProps, crashes, njspCrashesTotal, } }
}

const Home = ({ plotsDict, cc2mc2mn, njspProps, crashes, njspCrashesTotal, }: Props) => {
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
    const cc = null, mc = null
    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = getNjspCrashRows({ cc, mc, cc2mc2mn, crashes, }) ?? []
    const njspPagination = { ...njspPaginationControls, total: njspCrashesTotal }

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
            />
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
                <iframe src={`/map/hudson`} className={css.map} />
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
