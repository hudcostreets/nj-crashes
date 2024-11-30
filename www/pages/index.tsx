import React, { Fragment, useState } from 'react'
import type { GetServerSideProps } from 'next'
import Head from '@rdub/next-base/head'
import css from './index.module.scss'
import A from "@rdub/next-base/a";
import { url } from "@/src/site";
import { plotSpecs } from "@/src/plotSpecs";
import { buildPlots, Plot, PlotsDict } from "@rdub/next-plotly/plot";
import { loadPlots } from "@rdub/next-plotly/plot-load";
import { NjspPlot, PlotParams, Props as NjspProps } from "@/src/njsp/plot";
import { getUrls } from "@/src/urls";
import Footer from '@/src/footer';
import { H2 } from "@/pages/c/[[...region]]";
import { NjspSource } from "@/src/icons";
import { loadProps } from "@/server/njsp/plot";
import { CrashPage } from '@/src/njsp/crash';
import { CrashDB } from '@/server/njsp/sql';
import { NjspCrashesId, NjspCrashesTable } from "@/src/njsp/table";
import { CC2MC2MN, normalize } from "@/src/county";
import { cc2mc2mn, County2Code } from "@/server/county";
import { DefaultPageSize, PerPageKey } from "@/src/pagination";
import { Cookies, CookiesContext } from '@/src/cookies';
import { GetServerSidePropsContext } from "next/dist/types"
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@rdub/base/json/fetch";
import { encode } from "@rdub/next-params/query";
import * as q from "@/src/query";
import { spCrashesDdb } from "@/server/njsp/ddb";

type Props = {
    plotsDict: PlotsDict<PlotParams>
    initNjspPlot: NjspProps
    initNjsp: CrashPage
    pqtPage: CrashPage
    cc2mc2mn: CC2MC2MN
    County2Code: Record<string, number>
    cookies: Cookies
}

export function parsePerPage(req: GetServerSidePropsContext["req"], ppKey: string): { perPage: number, cookies: Cookies } {
    let perPage = DefaultPageSize
    const cookies: Cookies = {}
    const cookie = req.cookies[ppKey]
    if (cookie) {
        cookies[ppKey] = cookie
        perPage = parseInt(cookie)
    }
    console.log("cookies:", req.cookies, "perPage:", perPage)
    return { perPage, cookies }
}

export const getServerSideProps: GetServerSideProps<Props> = async ({ req }) => {
    const { perPage, cookies } = parsePerPage(req, PerPageKey(NjspCrashesId))
    const plotsDict = loadPlots(plotSpecs) as PlotsDict<PlotParams>
    const urls = getUrls({ local: true })
    const page = 0, cc = null, mc = null
    const crashDb = new CrashDB(urls.njsp.crashes)
    const [ crashes, njspCrashesTotal, initNjspPlot, pqtCrashes, pqtTotal ] = await Promise.all([
        crashDb.crashes({ cc, mc, page, perPage, }),
        crashDb.total({ cc, mc, }),
        loadProps({ county: null }),
        spCrashesDdb.crashes({ cc, mc, page, perPage, }),
        spCrashesDdb.total({ cc, mc, }),
    ])
    const initNjsp = { crashes, total: njspCrashesTotal, }
    const pqtPage: CrashPage = { crashes: pqtCrashes, total: pqtTotal }
    // console.log("pqtPage:", pqtPage)
    return { props: { plotsDict, initNjspPlot, initNjsp, pqtPage, cc2mc2mn, County2Code, cookies, } }
}

const Home = ({ plotsDict, initNjspPlot, initNjsp, pqtPage, cc2mc2mn, County2Code, cookies, }: Props) => {
    const plots: Plot[] = buildPlots(plotSpecs, plotsDict)
    const title = "NJ Traffic Crash Data"
    console.log("njsp pqtPage", pqtPage)
    console.log("njsp sqlPage", initNjsp)

    const [ county, setCounty ] = useState<string | null>(null)
    console.log("county:", county, County2Code)
    const { data: njspPlot } = useQuery({
        queryKey: [ "njspPlot", county, ],
        queryFn: async () => {
            const cc = county === null ? null : County2Code[normalize(county)]
            const query = encode(q.NjspPlot, { cc })
            console.log("njsp/plotProps:", county, cc, `?${query}`)
            return fetchJson<NjspProps>(`/api/njsp/plotProps/?${query}`)
        },
        initialData: county === null ? initNjspPlot : undefined,
        placeholderData: keepPreviousData,
    })

    return (
      <CookiesContext.Provider value={cookies}>
        <div className={css.container}>
            <Head
                title={title}
                description={"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT"}
                url={url}
                thumbnail={`${url}/plots/fatalities_per_year_by_type.png`}
            />
            {/*<Nav*/}
            {/*    id={"nav"}*/}
            {/*    classes={"collapsed"}*/}
            {/*    menus={menus}*/}
            {/*    hover={false}*/}
            {/*/>*/}
            <main className={css.index}>
                <h1 className={css.title}>{title}</h1>
                <div className={css["plot-container"]}>
                    {
                        njspPlot
                          ? <NjspPlot
                            {...njspPlot}
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
                            <NjspCrashesTable init={initNjsp} cc2mc2mn={cc2mc2mn}/>
                            <NjspSource/>
                        </div>
                        <hr/>
                    </div>
                }
                {
                    plots.map(
                      ({ id, ...rest }) =>
                        <Fragment key={id}>
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
                <p>
                    <span className={css.bold}>Work in progress</span> map of NJDOT data: 5 years (2017-2021) of fatal and injury crashes in Hudson County:
                </p>
                <iframe src={`/map/hudson`} className={css.map}/>
                <ul style={{ listStyle: "none" }}>
                    <li><A href={"/map/hudson"}>Full screen map here</A></li>
                </ul>
                <Footer/>
            </main>
        </div>
      </CookiesContext.Provider>
    )
}

export default Home
