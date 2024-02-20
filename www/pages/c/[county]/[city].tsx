import type { GetStaticProps } from "next";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { useMemo, useState } from "react";
import { ResultTable } from "@/src/result-table";
import { denormalize, normalize } from "@/src/county";
import css from "./city.module.scss"
import A from "@rdub/next-base/a";
import { map } from "fp-ts/either";
import { ColTitles, useYearStats, YearStatsDicts, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";
import { getDbUrls, Urls } from "@/src/urls";
import { usePaginationControls, useResultPagination } from "@/src/pagination";

export type Params = {
    county: string
    city: string
}

export type Props = {
    urls: Urls
    cc: number
    mc: number
} & Params

export function getStaticPaths() {
    const paths = concat(
        values(cc2mc2mn).map(({ cn, mc2mn }) =>
            values(mc2mn).map(city => ({
                params: {
                    county: normalize(cn),
                    city: normalize(city),
                }
            }))
        )
    )
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const urls = getDbUrls()
    let { county, city, } = params
    county = normalize(county)
    city = normalize(city)
    const cc = CountyCodes[county]
    const mc2mn = mapEntries(cc2mc2mn[cc].mc2mn, (mc, mn) => [ normalize(mn), mc ])
    const mc = mc2mn[city]
    return { props: { urls, county, city, cc, mc } }
}

export default function CityPage({ urls, county, city, cc, mc }: Props) {
    const paginationControls = usePaginationControls()
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const yearStatsResult = useYearStats({ url: urls.cmymc, requestChunkSize, cc, mc })
    const crashes = useCrashRows({ urls, requestChunkSize, cc, mc, ...paginationControls, })

    const [ title, countyTitle] = useMemo(() => {
        const cityTitle = denormalize(city)
        return [`${cityTitle}`, `${denormalize(county)} County`]
    },  [ city, county ])

    const pagination = useResultPagination(
        yearStatsResult,
        (ysds: YearStatsDicts) => ysds.totals.fc,
        paginationControls,
    )

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                <h3 className={css.subtitle}><A href={`/c/${county}`}>{countyTitle}</A></h3>
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
