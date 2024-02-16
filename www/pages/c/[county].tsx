import type { GetStaticProps } from "next";
import { getBasePath } from "@rdub/next-base/basePath";
import { useState } from "react";
import { ResultTable } from "@/src/result-table";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { denormalize, normalize } from "@/src/county";
import css from "@/pages/c/[county]/city.module.scss";
import { map } from "fp-ts/Either";
import { useTotals } from "@/src/use-totals";
import { Urls } from "@/pages/c/[county]/[city]";
import { useYearStats, YearStats, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";

export type Params = {
    county: string
}

export type Props = {
    urls: Urls
    cc: number
    mc2mn: { [mc: number]: string }
} & Params

export function getStaticPaths() {
    const paths = keys(CountyCodes).map(county => ({ params: { county: normalize(county) } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const basePath = getBasePath()
    const prefix = process.env['CI'] ? `https://nj-crashes.s3.amazonaws.com/njdot/data` : `${basePath}/njdot`
    const urls = {
        crashes: `${prefix}/crashes.db`,
        ymc: `${prefix}/ycm.db`,
    }
    let { county } = params
    county = normalize(county)
    const cc = CountyCodes[county]
    const mc2mn = cc2mc2mn[cc].mc2mn
    return { props: { urls, county, cc, mc2mn } }
}

export default function CountyPage({ urls, county, cc, mc2mn }: Props) {
    const [ perPage, setPerPage ] = useState<number>(20)
    const [ page, setPage ] = useState<number>(0)
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const crashes = useCrashRows({ url: urls.crashes, requestChunkSize, cc, page, perPage, mc2mn, })
    const totals = useTotals({ url: urls.ymc, requestChunkSize, cc }) ?? undefined
    // const totalsElem = useTotalsElem({ url: urls.ymc, requestChunkSize, cc })
    const years = useYearStats({ url: urls.ymc, requestChunkSize, cc, })

    const title = `${denormalize(county)} County`
    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                {
                    years && <>
                        <h2>Yearly stats</h2>
                        <ResultTable
                            className={css.crashesTable}
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
