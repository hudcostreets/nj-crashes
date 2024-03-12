import type { GetStaticProps } from "next";
import { cc2mc2mn, Counties, County2Code } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { CC2MC2MN, denormalize, normalize } from "@/src/county";
import { getUrls, NjdotRawData, NjspFatalAcc, Urls } from "@/src/urls";
import * as Njsp from "@/src/njsp/plot";
import { NjspPlot } from "@/src/njsp/plot";
import { loadProps } from "@/server/njsp/plot";
import { ReactNode, useState } from "react";
import useRegion from "@/src/use-region";
import { useDatePaginationControls, usePaginationControls, useResultDatePagination, useResultPagination } from "@/src/pagination";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useNjdotCrashRows } from "@/src/use-njdot-crashes";
import { Total, useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import singleton from "@rdub/base/singleton";
import css from "@/src/region-page.module.scss";
import CitySelect from "@/src/city-select";
import { CountySelect } from "@/src/county-select";
import { njspPlotSpec } from "@/src/plotSpecs";
import { ResultTable } from "@/src/result-table";
import A from "@rdub/next-base/a";
import { map } from "fp-ts/Either";
import Footer from "@/src/footer";

export const DOTStart = "2001-01-01"
export const DOTEnd = "2021-12-31"

export function H2({ id, children }: { id: string, children: ReactNode }) {
    return <h2>
        <span id={id} className={css.idTarget}/>
        <A href={`#${id}`}>{children}</A>
    </h2>
}

export type Params = {
    region: string[]
}

export type Props = {
    urls: Urls
    cc: number | null
    cp: string | null
    cn: string | null
    mc: number | null
    mn: string | null
    cc2mc2mn: CC2MC2MN
    barProps: Njsp.Props | null
    Counties: string[]
}

export function getStaticPaths() {
    const paths = concat([
        [{ params: { region: [] } }],  // NJ
        ...values(cc2mc2mn).map(({ cn, mc2mn }) =>
            [
                { params: { region: [ normalize(cn) ] } },  // Counties
                ...values(mc2mn).map(city => (
                    { params: { region: [ normalize(cn), normalize(city) ] } }  // Cities
                ))
            ]
        )
    ])
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
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
    const barProps = mn === null ? await loadProps({ county: cn }) : null
    return { props: { urls, cp, cn, cc, mc, mn, cc2mc2mn, Counties, barProps, } }
}

export default function CityPage({ urls, barProps, cp, Counties, ...regionProps }: Props) {
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    const { cc, mc, cn, mn, mc2mn, cc2mc2mn, setCounty, setCity, } = useRegion({ ...regionProps, urlPrefix: "/c", })
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

    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = useNjspCrashRows({ urls, cc, cn, mc, cc2mc2mn, ...njspPaginationControls, })
    const njspCrashesTotal = useNjspCrashesTotal({ urls, cc, mc, requestChunkSize, })
    const njspPagination = useResultPagination(
        njspCrashesTotal,
        (totals: Total[]) => singleton(totals).total,
        njspPaginationControls,
    )

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
                <h1 className={css.title}>{
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
                }</h1>
                {subtitle && <div className={css.subtitle}>{subtitle}</div>}
                {
                    barProps
                        ? <div className={css.njspPlot}>
                            <NjspPlot
                                {...barProps}
                                county={cn ?? null}
                                Heading={"h1"}
                                heading={<H2 id={"by-type"}>{plotTitle}</H2>}
                                spec={njspPlotSpec}
                            />
                        </div>
                        : null
                }
                {
                    njspCrashes && <div className={css.section}>
                        <H2 id={"recent"}>Recent fatal crashes</H2>
                        <div className={css.sectionSubtitle}>2008 – present</div>
                        <ResultTable
                            className={css.crashesTable}
                            result={njspCrashes}
                            pagination={njspPagination}
                        />
                        <div className={css.footer}>Source: <A href={NjspFatalAcc}>NJ State Police</A> (fatal crashes only; typically published between a day and a few months after the fact)</div>
                    </div>
                }
                {
                    njdotCrashes && <div className={css.section}>
                        <H2 id={"dot"}>Fatal / Injury crash details</H2>
                        <div className={css.sectionSubtitle}>2001-2021</div>
                        <ResultTable
                            className={css.crashesTable}
                            result={njdotCrashes}
                            pagination={njdotPagination}
                        />
                        <div className={css.footer}>Source: <A href={NjdotRawData}>NJ DOT</A> (includes non-fatal crashes; most recent data: 2021)</div>
                    </div>
                }
                {
                    yearStatsResult && <div className={css.section}>
                        <H2 id={"stats"}>Annual stats</H2>
                        <div className={css.sectionSubtitle}>2001-2021</div>
                        <ResultTable
                            className={`${css.crashesTable} ${css.withTotals}`}
                            result={map((ysds: YearStatsDicts) => yearStatsRows({ ysds }))(yearStatsResult)}
                            colTitles={ColTitles}
                        />
                    </div>
                }
                <Footer />
            </div>
        </div>
    )
}
