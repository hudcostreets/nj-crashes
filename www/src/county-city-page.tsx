import { usePaginationControls, useResultPagination } from "@/src/pagination";
import { ReactNode, useState } from "react";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";
import css from "@/pages/c/[county]/city.module.scss";
import { ResultTable } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { DOTUrls } from "@/src/urls";
import { MC2MN } from "@/src/county";

export type Props = {
    urls: DOTUrls
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
    const paginationControls = usePaginationControls()
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const yearStatsResult = useYearStats({ url: urls.cmymc, requestChunkSize, cc, mc })
    const crashes = useCrashRows({ urls, requestChunkSize, cc, mc, ...paginationControls, county: mc2mn ? { cn, mc2mn } : undefined, })

    const pagination = useResultPagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => ysds.totals.fc,
        paginationControls,
    )

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {subtitle && <h3 className={css.subtitle}>{subtitle}</h3>}
                {
                    yearStatsResult && <>
                        <h2>Yearly stats</h2>
                        <ResultTable
                            className={`${css.crashesTable} ${css.withTotals}`}
                            result={map((ysds: YearStatsDicts) => yearStatsRows({ ysds }))(yearStatsResult)}
                            colTitles={ColTitles}
                        />
                    </>
                }
                {
                    crashes && <>
                        <h2>Fatal crashes, 2001-2021</h2>
                        <ResultTable
                            className={css.crashesTable}
                            result={crashes}
                            pagination={pagination}
                        />
                    </>
                }
            </div>
        </div>
    )
}
