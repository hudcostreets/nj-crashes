import type { GetStaticProps } from "next";
import { useState } from "react";
import { ResultTable } from "@/src/result-table";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { County, denormalize, normalize } from "@/src/county";
import css from "@/pages/c/[county]/city.module.scss";
import { map } from "fp-ts/Either";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";
import { getDbUrls, Urls } from "@/src/urls";
import { usePaginationControls, useResultPagination } from "@/src/pagination";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
} & County & Params

export function getStaticPaths() {
    const paths = keys(CountyCodes).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getDbUrls()
    let { county } = params
    county = normalize(county)
    const cc = CountyCodes[county]
    return { props: { urls, county, cc, ...cc2mc2mn[cc] } }
}

export default function CountyPage({ urls, cc, ...county }: Props) {
    const paginationControls = usePaginationControls()
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const crashes = useCrashRows({ urls, requestChunkSize, cc, ...paginationControls, county, })
    const yearStatsResult = useYearStats({ url: urls.cmymc, requestChunkSize, cc, })
    const yearTableClass = `${css.crashesTable} ${css.withTotals}`
    const pagination = useResultPagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => ysds.totals.fc,
        paginationControls,
    )
    const { cn } = county
    const title = `${denormalize(cn)} County`
    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {
                    yearStatsResult && <>
                        <h2>Yearly stats</h2>
                        <ResultTable
                            className={yearTableClass}
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
                <div className={css.njspPlot}>

                </div>
            </div>
        </div>
    )
}
