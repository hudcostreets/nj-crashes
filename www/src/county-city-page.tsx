import { useDatePaginationControls, usePaginationControls, useResultDatePagination, useResultPagination } from "@/src/pagination";
import { ReactNode, useState } from "react";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useNjdotCrashRows } from "@/src/use-njdot-crashes";
import css from "./county-city.module.scss";
import { ResultTable } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { NjdotRawData, NjspFatalAcc, Urls } from "@/src/urls";
import { MC2MN } from "@/src/county";
import { Total, useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import singleton from "@rdub/base/singleton";
import A from "@rdub/next-base/a";
import * as Njsp from "@/src/njsp/plot";
import { NjspChildren, NjspPlot } from "@/src/njsp/plot";
import { njspPlotSpec } from "@/src/plotSpecs";

export type Props = {
    urls: Urls
    cc: number
    cn: string
    mc?: number
    mc2mn?: MC2MN
    barProps?: Njsp.Props
    title: string
    subtitle?: ReactNode
}

export const DOTStart = "2001-01-01"
export const DOTEnd = "2021-12-31"

export default function CityPage(
    {
        urls,
        cc, cn,
        mc, mc2mn,
        title, subtitle,
        barProps,
    }: Props
) {
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const njdotPaginationControls = useDatePaginationControls({ id: "njdot-crashes" }, { start: DOTStart, end: DOTEnd, })
    const yearStatsResult = useYearStats({ url: urls.dot.cmymc, cc, mc, requestChunkSize, })
    const njdotCrashes = useNjdotCrashRows({ urls, cc, cn, mc, mc2mn, ...njdotPaginationControls, requestChunkSize, })
    const njdotPagination = useResultDatePagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => {
            const { fc, sic, mic, pic, } = ysds.totals
            return fc + sic + mic + pic
        },
        njdotPaginationControls,
    )

    const njspPaginationControls = usePaginationControls({ id: "njsp-crashes" })
    const njspCrashes = useNjspCrashRows({ urls, cc, cn, mc, mc2mn, ...njspPaginationControls, })
    const njspCrashesTotal = useNjspCrashesTotal({ urls, cc, mc, requestChunkSize, })
    const njspPagination = useResultPagination(
        njspCrashesTotal,
        (totals: Total[]) => singleton(totals).total,
        njspPaginationControls,
    )

    // NJSP plot
    const spec = {
        ...njspPlotSpec,
        children: barProps
            ? <NjspChildren
                rundate={barProps.rundate}
                yearTotalsMap={barProps.yearTotalsMap}
                includeWorstYearsBlurb={false}
            />
            : null,
    }
    const plotTitle = `Deaths per year, by type`

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {subtitle && <div className={css.subtitle}>{subtitle}</div>}
                {
                    barProps &&
                    <div className={css.njspPlot}>
                        <NjspPlot
                            {...barProps}
                            heading={<h2>{plotTitle}</h2>}
                            title={plotTitle}
                            spec={spec}
                        />
                    </div>
                }
                {
                    njspCrashes && <div className={css.section}>
                        <h2>Fatal crashes</h2>
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
                        <h2>Fatal / Injury crash details</h2>
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
                        <h2>Annual stats</h2>
                        <div className={css.sectionSubtitle}>2001-2021</div>
                        <ResultTable
                            className={`${css.crashesTable} ${css.withTotals}`}
                            result={map((ysds: YearStatsDicts) => yearStatsRows({ ysds }))(yearStatsResult)}
                            colTitles={ColTitles}
                        />
                    </div>
                }
            </div>
        </div>
    )
}
