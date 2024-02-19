import type { GetStaticProps } from "next";
import { useState } from "react";
import { ResultTable } from "@/src/result-table";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { County, denormalize, normalize } from "@/src/county";
import css from "@/pages/c/[county]/city.module.scss";
import { map } from "fp-ts/Either";
import { useTotals } from "@/src/use-totals";
import { useYearStats, YearStats, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";
import { getDbUrls, Urls } from "@/src/urls";

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
    const [ perPage, setPerPage ] = useState<number>(20)
    const [ page, setPage ] = useState<number>(0)
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const crashes = useCrashRows({ urls, requestChunkSize, cc, page, perPage, county, })
    const totals = useTotals({ url: urls.cmym, requestChunkSize, cc }) ?? undefined
    // const totalsElem = useTotalsElem({ url: urls.ymc, requestChunkSize, cc })
    const years = useYearStats({ url: urls.cmym, requestChunkSize, cc, })
    const yearTableClass = `${css.crashesTable} ${totals ? css.withTotals : ``}`
    const { cn } = county
    const title = `${denormalize(cn)} County`
    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {
                    years && <>
                        <h2>Yearly stats</h2>
                        <ResultTable
                            className={yearTableClass}
                            result={map((years: YearStats[]) => yearStatsRows({ years, totals }))(years)}
                        />
                    </>
                }
                {
                    crashes && <>
                        <h2>Fatal crashes, 2001-2021</h2>
                        <ResultTable
                            className={css.crashesTable}
                            result={crashes}
                        />
                    </>
                }
                <div className={css.njspPlot}>

                </div>
            </div>
        </div>
    )
}
