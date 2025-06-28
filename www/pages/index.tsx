import { fetchJson } from "@rdub/base/json/fetch"
import A from "@rdub/next-base/a"
import Head from '@rdub/next-base/head'
import { encode } from "@rdub/next-params/query"
import { buildPlots, Plot, PlotsDict } from "@rdub/next-plotly/plot"
import { loadPlots } from "@rdub/next-plotly/plot-load"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { GetServerSidePropsContext } from "next/dist/types"
import React, { Fragment, useState } from 'react'
import { H2 } from "@/pages/c/[[...region]]"
import { cc2mc2mn, County2Code } from "@/server/county"
import { getCrashPage } from "@/server/crash-page"
import { getVsHomicides } from "@/server/crime/vs-homicides"
import * as VsHomicides from "@/server/crime/vs-homicides"
import { spDdb } from "@/server/njsp/ddb"
import { loadProps } from "@/server/njsp/plot"
import { Cookies, CookiesContext } from '@/src/cookies'
import { CC2MC2MN, normalize } from "@/src/county"
import Footer from '@/src/footer'
import { NjspSource } from "@/src/icons"
import { CrashPage } from '@/src/njsp/crash'
import { NjspPlot, PlotParams, Props as NjspProps } from "@/src/njsp/plot"
import { NjspCrashesId, NjspCrashesTable } from "@/src/njsp/table"
import { VsHomicidesPlot } from "@/src/njsp/vs-homicides-plot"
import { DefaultPageSize, PerPageKey } from "@/src/pagination"
import { plotSpecs } from "@/src/plotSpecs"
import * as q from "@/src/query"
import { url } from "@/src/site"
import css from './index.module.scss'
import type { GetServerSideProps } from 'next'

type Props = {
  plotsDict: PlotsDict<PlotParams>
  initNjspPlot: NjspProps
  initNjsp: CrashPage
  vsHomicides: VsHomicides.Row[]
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
  const page = 0, cc = null, mc = null
  const [ initNjsp, initNjspPlot, vsHomicides ] = await Promise.all([
    getCrashPage(spDdb, { cc, mc, page, perPage, }),
    loadProps({ county: null }),
    getVsHomicides({ cc: null }),
  ])
  // console.log("pqtPage:", pqtPage)
  return { props: { plotsDict, initNjspPlot, initNjsp, vsHomicides, cc2mc2mn, County2Code, cookies, } }
}

const Home = ({ plotsDict, initNjspPlot, initNjsp, vsHomicides, cc2mc2mn, County2Code, cookies, }: Props) => {
  const plots: Plot[] = buildPlots(plotSpecs, plotsDict)
  const title = "NJ Car Crashes"
  // console.log("njsp sqlPage", initNjsp)

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
    initialData: initNjspPlot,
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
        <main className={css.index}>
          <h1 className={css.title}>{title}</h1>
          <div className={css["plot-container"]}>
            <NjspPlot
              {...njspPlot}
              county={county}
              setCounty={setCounty}
              includeMoreInfoLink={true}
            />
            <hr/>
          </div>
          <div className={css["plot-container"]}>
            <div className={css.section}>
              <H2 id={"recent-fatal-crashes"}>Recent fatal crashes</H2>
              <NjspCrashesTable init={initNjsp} cc2mc2mn={cc2mc2mn}/>
              <NjspSource/>
            </div>
            <hr/>
          </div>
          <div className={css["plot-container"]}>
            <VsHomicidesPlot rows={vsHomicides} ytRows={njspPlot.ytRows} />
            <hr/>
          </div>
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
