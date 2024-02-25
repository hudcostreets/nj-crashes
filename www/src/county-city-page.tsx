import { usePaginationControls, useResultPagination } from "@/src/pagination";
import { ReactNode, useState } from "react";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useNjdotCrashRows } from "@/src/use-njdot-crashes";
import css from "@/pages/c/[county]/city.module.scss";
import { ResultTable } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { NjdotRawData, NjspFatalAcc, Urls } from "@/src/urls";
import { MC2MN } from "@/src/county";
import { Total, useNjspCrashesTotal, useNjspCrashRows } from "@/src/use-njsp-crashes";
import singleton from "@rdub/base/singleton";
import A from "@rdub/next-base/a";

export type Props = {
    urls: Urls
    cc: number
    cn: string
    mc?: number
    mc2mn?: MC2MN
    title: string
    subtitle?: ReactNode
}

export default function CityPage(
    {
        urls,
        cc, cn,
        mc, mc2mn,
        title, subtitle
    }: Props
) {
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const njdotPaginationControls = usePaginationControls({ id: "njdot-crashes" })
    const yearStatsResult = useYearStats({ url: urls.dot.cmymc, cc, mc, requestChunkSize, })
    const njdotCrashes = useNjdotCrashRows({ urls, cc, cn, mc, mc2mn, ...njdotPaginationControls, requestChunkSize, })
    const njdotPagination = useResultPagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => ysds.totals.fc,
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

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {subtitle && <div className={css.subtitle}>{subtitle}</div>}
                {
                    njspCrashes && <div className={css.section}>
                        <h2>Fatal crashes</h2>
                        <ResultTable
                            className={css.crashesTable}
                            result={njspCrashes}
                            pagination={njspPagination}
                        />
                        <div className={css.footer}>Source: <A href={NjspFatalAcc}>NJ State Police</A> (fatal crashes only, 2008-present; typically published between a day and a few months after the fact)</div>
                    </div>
                }
                {
                    njdotCrashes && <div className={css.section}>
                        <h2>Fatal crash details (2001-2021)</h2>
                        <ResultTable
                            className={css.crashesTable}
                            result={njdotCrashes}
                            pagination={njdotPagination}
                        />
                        <div className={css.footer}>Source: <A href={NjdotRawData}>NJ DOT</A> (includes non-fatal crashes, published ≈2 years after the fact; most recent data: 2021)</div>
                    </div>
                }
                {
                    yearStatsResult && <>
                        <h2>Yearly stats (2001-2021)</h2>
                        <ResultTable
                            className={`${css.crashesTable} ${css.withTotals}`}
                            result={map((ysds: YearStatsDicts) => yearStatsRows({ ysds }))(yearStatsResult)}
                            colTitles={ColTitles}
                        />
                    </>
                }
            </div>
        </div>
    )
}
