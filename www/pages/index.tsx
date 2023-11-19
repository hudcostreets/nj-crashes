import React, {Fragment} from 'react'
import type {GetStaticProps} from 'next'
import {Head} from 'next-utils/head'
import css from './index.module.css'
import A from "next-utils/a";
import {Nav} from "next-utils/nav";
import {getBasePath} from "next-utils/basePath"
import {Socials} from "next-utils/socials"
import {GitHub, url} from "../src/socials"
import {HasTotals, Plot, plotSpecs, ProjectedTotals} from "../src/plotSpecs";
import {loadSync} from "next-utils/load";
import {build, PlotsDict} from "next-utils/plot";
import PlotsLoad from "next-utils/plot-load";

type Props = { plotsDict: PlotsDict, rundate: string, } & HasTotals

export const getStaticProps: GetStaticProps = async () => {
    const { rundate } = loadSync<{ rundate: string }>(`public/rundate.json`)
    console.log(`rundate: ${rundate}`)
    const plotsDict: PlotsDict = PlotsLoad(plotSpecs)
    const projectedTotals = loadSync<ProjectedTotals>(`public/plots/projected_totals.json`)
    return { props: { plotsDict, projectedTotals, rundate, }, }
}

const Home = ({ plotsDict, projectedTotals, rundate, }: Props) => {
    // console.log("Home plots:", plotsDict)
    const basePath = getBasePath()

    const plots: Plot[] = build(plotSpecs, plotsDict, { rundate, projectedTotals })
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
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css" />
            </Nav>

            <main className={css.main}>
                <h1 className={css.title}>{title}</h1>
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
                            <div key={id} className={css["plot-container"]}>
                                <Plot id={id} basePath={basePath} {...rest} margin={{ b: 30, }} data={{ rundate, projectedTotals }} />
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
