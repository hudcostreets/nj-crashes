import { Home } from "@mui/icons-material"
import { mapEntries, values } from "@rdub/base"
import A from "@rdub/next-base/a"
import { WithRouteIsChanging } from "@rdub/next-base/route-is-changing"
import { right } from "fp-ts/Either"
import { ReactNode } from "react"
import { parsePerPage } from "@/pages"
import { cc2mc2mn, Counties, County2Code } from "@/server/county"
import { getCrashPage } from "@/server/crash-page"
import * as VsHomicides from "@/server/crime/vs-homicides"
import { getVsHomicides } from "@/server/crime/vs-homicides"
import { dotDdb } from "@/server/njdot/ddb"
import { spDdb } from "@/server/njsp/ddb"
import { loadProps } from "@/server/njsp/plot"
import CitySelect from "@/src/city-select"
import { Cookies, CookiesContext } from "@/src/cookies"
import { CC2MC2MN, denormalize, normalize } from "@/src/county"
import { CountySelect } from "@/src/county-select"
import Footer from "@/src/footer"
import { NjdotSource, NjspSource } from "@/src/icons"
import * as DOT from "@/src/njdot/crash"
import { NjdotCrashesTable } from "@/src/njdot/table"
import * as SP from "@/src/njsp/crash"
import { NjspPlot, Props as NjspProps } from "@/src/njsp/plot"
import { CCMC } from "@/src/njsp/region"
import { NjspCrashesId, NjspCrashesTable } from "@/src/njsp/table"
import { VsHomicidesPlot } from "@/src/njsp/vs-homicides-plot"
import { PerPageKey } from "@/src/pagination"
import css from "@/src/region-page.module.scss"
import { ResultTable } from "@/src/result-table"
import tableCss from "@/src/result-table.module.scss"
import { urls, Urls } from "@/src/urls"
import useRegion from "@/src/use-region"
import { ColTitles, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats"
import type { GetServerSideProps } from "next"

export const EndYear = 2022

export function H2({ id, className = css.idTarget, children }: { id: string, className?: string, children: ReactNode }) {
  return <h2>
    <span id={id} className={className}/>
    <A href={`#${id}`}>{children}</A>
  </h2>
}

export type Props = {
    urls: Urls
    cp: string | null
    cn: string | null
    mn: string | null
    cc2mc2mn: CC2MC2MN
    njspProps: NjspProps | null
    Counties: string[]
    spPage: SP.CrashPage
    dotPage: DOT.CrashPage
    vsHomicides: VsHomicides.Row[]
    yearStatsDicts: YearStatsDicts
    cookies: Cookies
} & CCMC

export type Params = {
    region: string[]
}

export const getServerSideProps: GetServerSideProps<Props, Params> = async ({ params, req, }) => {
  if (!params) {
    return { notFound: true }
  }
  let { region = [] } = params
  if (region.length > 2) {
    return { notFound: true }
  }
  const { perPage, cookies } = parsePerPage(req, PerPageKey(NjspCrashesId))
  const cp = region.length > 0 ? region[0] : null
  const mp = region.length > 1 ? region[1] : null
  let cc = null, cn = null, mc = null, mn = null
  if (cp) {
    cc = County2Code[cp]
    const county = cc2mc2mn[cc]
    const { mc2mn } = county
    cn = county.cn
    const mn2mc = mapEntries(mc2mn, (mc, mn) => [ normalize(mn), mc ])
    if (mp) {
      mc = mn2mc[mp]
      mn = denormalize(mp)
    }
  }
  const page = 0
  const [ spPage, njspProps, dotPage, vsHomicides, yearStatsDicts, ] = await Promise.all([
    getCrashPage(spDdb, { cc, mc, page, perPage, }),
    mn === null ? loadProps({ county: cn }) : Promise.resolve(null),
    getCrashPage(dotDdb, { cc, mc, page, perPage, }),  // before: DOTEnd
    getVsHomicides({ cc }),
    dotDdb.yearStats({ cc, mc, }),
  ])
  return { props: { urls, cp, cn, cc, mc, mn, cc2mc2mn, Counties, njspProps, spPage, dotPage, vsHomicides, yearStatsDicts, cookies, } }
}

export default function RegionPage({ urls, njspProps, spPage, dotPage, vsHomicides, yearStatsDicts, cp, cc2mc2mn, Counties, cookies, ...regionProps }: Props) {
  const { cc, mc, cn, mn, mc2mn, setCounty, setCity, } = useRegion({ ...regionProps, cc2mc2mn, urlPrefix: "/c", })
  const ysrs = yearStatsRows({ ysds: yearStatsDicts, })
  console.log(`cc ${cc} mc ${mc}`)
  const title= mn ?? cn ? `${mn} County` : "New Jersey"
  const subtitle =
        mn &&
        <span>
            (<A href={`/c/${cp}`}>{cn} County</A>)
        </span>

  return (
    <WithRouteIsChanging>
      <CookiesContext.Provider value={cookies}>
        <div className={css.body}>
          <div className={css.container}>
            <h1 className={css.title}>
              <span className={css.home}>
                <A href={"/"}>
                  <Home fontSize={"medium"} />
                </A>
              </span>
              {
                (setCity && mc && mc2mn)
                  ? <CitySelect
                    city={mc2mn[mc]}
                    setCity={setCity}
                    cities={values(mc2mn)}
                  />
                  : setCounty
                    ? <CountySelect
                      county={cn ?? null}
                      setCounty={setCounty}
                      Counties={Counties}
                    />
                    : title
              }
            </h1>
            {subtitle && <div className={css.subtitle}>{subtitle}</div>}
            {
              njspProps
                ? <div className={css.section}>
                  <div className={css.njspPlot}>
                    <NjspPlot
                      {...njspProps}
                      county={cn ?? null}
                      Heading={"h1"}
                      heading={<H2 id={"by-type"}>Car crash deaths</H2>}
                    />
                  </div>
                </div>
                : null
            }
            {
              <div className={css.section}>
                <H2 id={"recent"}>Recent fatal crashes</H2>
                <div className={css.sectionSubtitle}>2008 – present</div>
                <NjspCrashesTable
                  init={spPage}
                  cc={cc} mc={mc}
                  cc2mc2mn={cc2mc2mn}
                />
                <NjspSource />
              </div>
            }
            {
              njspProps
                ? <div className={css.homicidesPlot}>
                  <VsHomicidesPlot rows={vsHomicides} ytRows={njspProps.ytRows} />
                </div>
                : null
            }
            {
              <div className={css.section}>
                <H2 id={"dot"}>Fatal / Injury crash details</H2>
                <div className={css.sectionSubtitle}>2001-{EndYear}</div>
                <NjdotCrashesTable
                  init={dotPage}
                  cc={cc} mc={mc}
                  cc2mc2mn={cc2mc2mn}
                />
                <NjdotSource />
              </div>
            }
            {
              <div className={css.section}>
                <H2 id={"stats"}>Annual stats</H2>
                <div className={css.sectionSubtitle}>2001-{EndYear}</div>
                <ResultTable
                  className={tableCss.yearStatsTable}
                  result={right(ysrs)}
                  colTitles={ColTitles}
                />
                <NjdotSource />
              </div>
            }
            <Footer />
          </div>
        </div>
      </CookiesContext.Provider>
    </WithRouteIsChanging>
  )
}
