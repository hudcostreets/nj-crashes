import type { GetStaticProps } from "next";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { getBasePath } from "@rdub/next-base/basePath";
import { useMemo, useState } from "react";
import { Col, crashRows, ResultTable, yearRows } from "@/src/result-table";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { denormalize, normalize } from "@/src/county";
import css from "@/pages/c/[county]/city.module.scss";
import { map } from "fp-ts/Either";
import { Crash } from "@/src/crash";
import { useTotalsElem } from "@/src/use-totals";
import { Urls } from "@/pages/c/[county]/[city]";
import { useYearStats } from "@/src/use-year-stats";

export const maxBytesToRead = 20 * 1024 * 1024

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

    const query = useMemo(
        () => {
            const offset = page * perPage
            return `
                select * from crashes
                where severity='f' and cc=${cc}
                order by dt desc
                limit ${perPage} offset ${offset}
            `
        },
        [ page, perPage ]
    )
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    const crashesResult = useSqlQuery({ url: urls.crashes, requestChunkSize, query, maxBytesToRead })
    const cols: Col[] = [ 'dt', 'mc', 'casualties', 'road', 'cross_street', 'mp', 'll', ]
    const crashes = useMemo(
        () => crashesResult && map((crashes: Crash[]) => crashRows({ rows: crashes, cols, mc2mn, }))(crashesResult),
        [ crashesResult, cols ]
    )
    const totalsElem = useTotalsElem({ url: urls.ymc, requestChunkSize, cc })
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
                            result={map(yearRows)(years)}
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
                <h2>2001-2021 totals</h2>
                {totalsElem}
                <div className={css.njspPlot}>

                </div>
            </div>
        </div>
    )
}
