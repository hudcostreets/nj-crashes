import type { GetServerSideProps } from "next";
import { cc2mc2mn, Counties, County2Code } from "@/server/county";
import { mapEntries, values } from "@rdub/base/objs";
import { CC2MC2MN, denormalize, normalize } from "@/src/county";
import { getUrls, Urls } from "@/src/urls";
import { NjspPlot, Props as NjspProps } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { ReactNode } from "react";
import useRegion from "@/src/use-region";
import { useDatePaginationControls, usePaginationControls } from "@/src/pagination";
import { ColTitles, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { getNjdotCrashRows } from "@/src/use-njdot-crashes";
import css from "@/src/region-page.module.scss";
import CitySelect from "@/src/city-select";
import { CountySelect } from "@/src/county-select";
import { njspPlotSpec } from "@/src/plotSpecs";
import { ResultTable } from "@/src/result-table";
import A from "@rdub/next-base/a";
import { right } from "fp-ts/Either";
import Footer from "@/src/footer";
import { NjdotSource, NjspSource } from "@/src/icons";
import { Home } from "@mui/icons-material";
import { Crashes } from "@/server/njsp/sql";
import { DOTCrashDb } from "@/server/njdot/sql";
import { Crash } from "@/src/njsp/crash";
import { CrashRec } from "@/src/njdot/crash";
import { getNjspCrashRows } from "@/src/use-njsp-crashes";

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
    cc: number | null
    cp: string | null
    cn: string | null
    mc: number | null
    mn: string | null
    cc2mc2mn: CC2MC2MN
    njspProps: NjspProps | null
    Counties: string[]
    dotCrashes: CrashRec[]
    crashes: Crash[]
    njspCrashesTotal: number
    yearStatsDicts: YearStatsDicts
}

export type Params = {
    region: string[]
}

export const getServerSideProps: GetServerSideProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getUrls()
    let { region = [] } = params
    if (region.length > 2) {
        return { notFound: true }
    }
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
    const page = 0, perPage = 10
    const crashDb = new Crashes(urls.njsp.crashes)
    const dotCrashDb = new DOTCrashDb(urls.dot.crashes)
    const [ crashes, njspCrashesTotal, njspProps, dotCrashes, yearStatsDicts, ] = await Promise.all([
        crashDb.crashes({ cc, mc, page, perPage, }),
        crashDb.total({ cc, mc, }),
        mn === null ? loadProps({ county: cn }) : Promise.resolve(null),
        dotCrashDb.crashRecs({ cc, mc, before: DOTEnd, perPage, }),
        dotCrashDb.yearStats({ cc, mc, }),
    ])
    return { props: { urls, cp, cn, cc, mc, mn, cc2mc2mn, Counties, njspProps, dotCrashes, crashes, njspCrashesTotal, yearStatsDicts, } }
}

export default function RegionPage({ urls, njspProps, dotCrashes, crashes, njspCrashesTotal, yearStatsDicts, cp, cc2mc2mn, Counties, ...regionProps }: Props) {
    const { cc, mc, cn, mn, mc2mn, setCounty, setCity, } = useRegion({ ...regionProps, cc2mc2mn, urlPrefix: "/c", })
    const njdotPaginationControls = useDatePaginationControls({ id: "njdot-crashes" }, { start: DOTStart, end: DOTEnd, })
    const njdotCrashes = getNjdotCrashRows({ cc, mc, cc2mc2mn, recs: dotCrashes, })
    const { fc, sic, mic, pic, } = yearStatsDicts.totals
    const yearStatsTotal =  fc + sic + mic + pic
    const njdotPagination = {
        ...njdotPaginationControls,
        total: yearStatsTotal,
    }
    const ysrs = yearStatsRows({ ysds: yearStatsDicts, })
    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = getNjspCrashRows({ cc, mc, cc2mc2mn, crashes, }) ?? []
    const njspPagination = { ...njspPaginationControls, total: njspCrashesTotal }

    const title= mn ?? cn ? `${mn} County` : "New Jersey"
    const subtitle =
        mn &&
        <span>
            (<A href={`/c/${cp}`}>{cn} County</A>)
        </span>

    // NJSP plot
    const plotTitle = `Car crash deaths`

    return (
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
                                spec={njspPlotSpec}
                              />
                          </div>
                      </div>
                      : null
                }
                {
                    njspCrashes && <div className={css.section}>
                        <H2 id={"recent"}>Recent fatal crashes</H2>
                        <div className={css.sectionSubtitle}>2008 – present</div>
                        <ResultTable
                            result={right(njspCrashes)}
                            pagination={njspPagination}
                        />
                        <NjspSource />
                    </div>
                }
                {
                    njdotCrashes && <div className={css.section}>
                        <H2 id={"dot"}>Fatal / Injury crash details</H2>
                        <div className={css.sectionSubtitle}>2001-{EndYear}</div>
                        <ResultTable
                            result={right(njdotCrashes)} // TODO: real error-handling
                            pagination={njdotPagination}
                        />
                        <NjdotSource />
                    </div>
                }
                {
                    <div className={css.section}>
                        <H2 id={"stats"}>Annual stats</H2>
                        <div className={css.sectionSubtitle}>2001-{EndYear}</div>
                        <ResultTable
                            className={css.withTotals}
                            result={right(ysrs)}
                            colTitles={ColTitles}
                        />
                        <NjdotSource />
                    </div>
                }
                <Footer />
            </div>
        </div>
    )
}
