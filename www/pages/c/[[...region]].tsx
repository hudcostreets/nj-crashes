import type { GetServerSideProps } from "next";
import { cc2mc2mn, Counties, County2Code } from "@/server/county";
import { mapEntries, values } from "@rdub/base/objs";
import { CC2MC2MN, denormalize, normalize } from "@/src/county";
import { getUrls, Urls } from "@/src/urls";
import { NjspPlot, Props as NjspProps } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { ReactNode } from "react";
import useRegion from "@/src/use-region";
import { PerPageKey } from "@/src/pagination";
import { ColTitles, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import css from "@/src/region-page.module.scss";
import tableCss from "@/src/result-table.module.scss";
import CitySelect from "@/src/city-select";
import { CountySelect } from "@/src/county-select";
import { ResultTable } from "@/src/result-table";
import A from "@rdub/next-base/a";
import { right } from "fp-ts/Either";
import Footer from "@/src/footer";
import { NjdotSource, NjspSource } from "@/src/icons";
import { Home } from "@mui/icons-material";
import { CrashDB } from "@/server/njsp/sql";
import { DotSql } from "@/server/njdot/sql";
import * as SP from "@/src/njsp/crash";
import * as DOT from "@/src/njdot/crash";
import { NjspCrashesId, NjspCrashesTable } from "@/src/njsp/table";
import { Cookies, CookiesContext } from "@/src/cookies";
import { parsePerPage } from "@/pages";
import { NjdotCrashesTable } from "@/src/njdot/table";
import { CCMC } from "@/src/njsp/region";
import { CrashPage } from "@/src/crash";

export const DOTStart = "2001-01-01"
export const EndYear = 2022
export const DOTEnd = `${EndYear}-12-31`

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
    spPage: CrashPage<SP.Crash>
    dotPage: CrashPage<DOT.Crash>
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
    const urls = getUrls({ local: true })
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
    const spDb = new CrashDB(urls.njsp.crashes)
    const dotDbs = new DotSql(urls.dot)
    const [ spPage, njspProps, dotPage, yearStatsDicts, ] = await Promise.all([
        spDb.crashPage({ cc, mc, page, perPage, }),
        mn === null ? loadProps({ county: cn }) : Promise.resolve(null),
        dotDbs.crashPage({ cc, mc, page, perPage, }),  // before: DOTEnd
        dotDbs.yearStats({ cc, mc, }),
    ])
    return { props: { urls, cp, cn, cc, mc, mn, cc2mc2mn, Counties, njspProps, spPage, dotPage, yearStatsDicts, cookies, } }
}

export default function RegionPage({ urls, njspProps, spPage, dotPage, yearStatsDicts, cp, cc2mc2mn, Counties, cookies, ...regionProps }: Props) {
    const { cc, mc, cn, mn, mc2mn, setCounty, setCity, } = useRegion({ ...regionProps, cc2mc2mn, urlPrefix: "/c", })
    const ysrs = yearStatsRows({ ysds: yearStatsDicts, })
    console.log(`cc ${cc} mc ${mc}`)
    const title= mn ?? cn ? `${mn} County` : "New Jersey"
    const subtitle =
        mn &&
        <span>
            (<A href={`/c/${cp}`}>{cn} County</A>)
        </span>

    // NJSP plot
    const plotTitle = `Car crash deaths`

    return (
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
                                heading={<H2 id={"by-type"}>{plotTitle}</H2>}
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
    )
}
