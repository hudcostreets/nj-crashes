import type { GetStaticProps } from "next";
import { cc2mc2mn, Counties } from "@/server/county";
import { values } from "@rdub/base/objs";
import { CC2MC2MN } from "@/src/county";
import { getUrls } from "@/src/urls";
import { NjspPlot } from "@/src/njsp/plot";
import { loadProps } from "@/src/njsp/plot";
import { ReactNode, useEffect, useState } from "react";
import useRegion from "@/src/use-region";
import { useDatePaginationControls, usePaginationControls, useResultDatePagination } from "@/src/pagination";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useNjdotCrashRows } from "@/src/use-njdot-crashes";
import { useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import css from "@/src/region-page.module.scss";
import CitySelect from "@/src/city-select";
import { CountySelect } from "@/src/county-select";
import { njspPlotSpec } from "@/src/plotSpecs";
import { ResultTable } from "@/src/result-table";
import A from "@rdub/next-base/a";
import { map, right } from "fp-ts/Either";
import Footer from "@/src/footer";
import { NjdotSource, NjspSource } from "@/src/icons";
import { Home } from "@mui/icons-material";
import { useDb } from "@rdub/duckdb-wasm/duckdb";
import { useQuery } from "@tanstack/react-query";
import { parseHashParams, updateHashParams } from "@rdub/next-params/hash";
import { Param, ParsedParam, stringParam } from "@rdub/next-params/params";

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
    cc2mc2mn: CC2MC2MN
    Counties: string[]
}

export const getStaticProps: GetStaticProps<Props> = async () => {
    return { props: { cc2mc2mn, Counties } }
}

export type Params = {
    c: Param<string | undefined>,
    m: Param<string | undefined>,
}

const params: Params = {
    c: stringParam(),
    m: stringParam(),
}

export type ParsedParams = {
    c: ParsedParam<string | undefined>
    m: ParsedParam<string | undefined>
}

export default function RegionPage({ cc2mc2mn, Counties }: Props) {
    const urls = getUrls()
    const {
        c: [ cs, setCs ],
        m: [ ms, setMs ],
    }: ParsedParams = parseHashParams({ params, })
    useEffect(
      () => {
          console.log("updateHashParams:", cs, ms)
          updateHashParams(params, { c: cs, m: ms,}, { push: true, log: true })
      },
      [ cs, ms ]
    )
    console.log(`cs: ${cs}, ms ${ms}`)
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    const { cc, mc, cn, mn, mc2mn, setCounty, setCity, } = useRegion({ cs, setCs, ms, setMs, cc2mc2mn, urlPrefix: "/c", })
    const njdotPaginationControls = useDatePaginationControls({ id: "njdot-crashes" }, { start: DOTStart, end: DOTEnd, })
    const yearStatsResult = useYearStats({ url: urls.dot.cmymc, cc, mc, requestChunkSize, })
    const njdotCrashes = useNjdotCrashRows({ urls, cc, cn, mc, cc2mc2mn, ...njdotPaginationControls, requestChunkSize, })
    const njdotPagination = useResultDatePagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => {
            const { fc, sic, mic, pic, } = ysds.totals
            return fc + sic + mic + pic
        },
        njdotPaginationControls,
    )

    const dbc = useDb()
    const { data: njspProps } = useQuery({
        queryKey: [ "njspProps", cn, dbc === null, ],
        refetchOnWindowFocus: false,
        refetchInterval: false,
        queryFn: async () => {
            if (!dbc) return null
            const { db, conn } = dbc
            return loadProps({ db, conn, county: cn ?? null, Counties, })
        }
    })

    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = useNjspCrashRows({ urls, cc, cn, mc, cc2mc2mn, ...njspPaginationControls, }) ?? []
    const njspCrashesTotal = useNjspCrashesTotal({ urls, cc, mc, requestChunkSize, })
    const njspPagination = { ...njspPaginationControls, total: njspCrashesTotal?.total ?? 0 }

    const title= mn ?? cn ? `${mn} County` : "New Jersey"
    const subtitle =
        mn &&
        <span>
            (<A href={`/c#c=${cs}`}>{cn} County</A>)
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
                            result={njdotCrashes}
                            pagination={njdotPagination}
                        />
                        <NjdotSource />
                    </div>
                }
                {
                    yearStatsResult && <div className={css.section}>
                        <H2 id={"stats"}>Annual stats</H2>
                        <div className={css.sectionSubtitle}>2001-{EndYear}</div>
                        <ResultTable
                            className={css.withTotals}
                            result={map((ysds: YearStatsDicts) => yearStatsRows({ ysds }))(yearStatsResult)}
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
