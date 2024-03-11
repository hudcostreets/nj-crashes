import { useDatePaginationControls, usePaginationControls, useResultDatePagination, useResultPagination } from "@/src/pagination";
import { Dispatch, ReactNode, useState } from "react";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useNjdotCrashRows } from "@/src/use-njdot-crashes";
import css from "./region-page.module.scss";
import { ResultTable } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { NjdotRawData, NjspFatalAcc, Urls } from "@/src/urls";
import { CC2MC2MN, MC2MN } from "@/src/county";
import { Total, useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import singleton from "@rdub/base/singleton";
import A from "@rdub/next-base/a";
import * as Njsp from "@/src/njsp/plot";
import { NjspPlot } from "@/src/njsp/plot";
import { njspPlotSpec } from "@/src/plotSpecs";
import Footer from "./footer";
import { CountySelect } from "@/src/county-select";

export type Props = {
    urls: Urls
    cc?: number
    cn?: string
    mc?: number
    mc2mn?: MC2MN
    cc2mc2mn?: CC2MC2MN
    barProps?: Njsp.Props
    setCounty?: Dispatch<string | null>
    title: string
    subtitle?: ReactNode
}

export const DOTStart = "2001-01-01"
export const DOTEnd = "2021-12-31"

export function H2({ id, children }: { id: string, children: ReactNode }) {
    return <h2>
        <span id={id} className={css.idTarget}/>
        <A href={`#${id}`}>{children}</A>
    </h2>
}

export default function RegionPage(
    {
        urls,
        cc, cn,
        mc, mc2mn,
        cc2mc2mn,
        title, subtitle,
        barProps,
        setCounty,
    }: Props
) {
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const njdotPaginationControls = useDatePaginationControls({ id: "njdot-crashes" }, { start: DOTStart, end: DOTEnd, })
    const yearStatsResult = useYearStats({ url: urls.dot.cmymc, cc, mc, requestChunkSize, })
    const njdotCrashes = useNjdotCrashRows({ urls, cc, cn, mc, mc2mn, cc2mc2mn, ...njdotPaginationControls, requestChunkSize, })
    const njdotPagination = useResultDatePagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => {
            const { fc, sic, mic, pic, } = ysds.totals
            return fc + sic + mic + pic
        },
        njdotPaginationControls,
    )

    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = useNjspCrashRows({ urls, cc, cn, mc, mc2mn, cc2mc2mn, ...njspPaginationControls, })
    const njspCrashesTotal = useNjspCrashesTotal({ urls, cc, mc, requestChunkSize, })
    const njspPagination = useResultPagination(
        njspCrashesTotal,
        (totals: Total[]) => singleton(totals).total,
        njspPaginationControls,
    )

    // NJSP plot
    const plotTitle = `Car crash deaths`
    const county = barProps?.county ?? null

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{
                    barProps && setCounty
                        ? <CountySelect
                            region={county ?? "NJ"}
                            setRegion={region => setCounty(region === "NJ" ? null : region)}
                            counties={barProps.counties}
                        />
                        : title
                }</h1>
                {subtitle && <div className={css.subtitle}>{subtitle}</div>}
                {
                    barProps
                        ? <div className={css.njspPlot}>
                            <NjspPlot
                                {...barProps}
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
