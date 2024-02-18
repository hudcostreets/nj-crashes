import type { GetStaticProps } from "next";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { useMemo, useState } from "react";
import { ResultTable } from "@/src/result-table";
import { denormalize, normalize } from "@/src/county";
import css from "./city.module.scss"
import A from "@rdub/next-base/a";
import { map } from "fp-ts/either";
import { useTotals } from "@/src/use-totals";
import { useYearStats, YearStats, yearStatsRows } from "@/src/use-year-stats";
import { useCrashRows } from "@/src/use-crashes";
import { getDbUrls, Urls } from "@/src/urls";

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
    const [ perPage, setPerPage ] = useState<number>(20)
    const [ page, setPage ] = useState<number>(0)
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)

    const totals = useTotals({ url: urls.cmym, requestChunkSize, cc, mc }) ?? undefined
    const years = useYearStats({ url: urls.cmym, requestChunkSize, cc, mc })
    const crashes = useCrashRows({ urls, requestChunkSize, cc, mc, page, perPage, })

    const [ title, countyTitle] = useMemo(() => {
        const cityTitle = denormalize(city)
        return [`${cityTitle}`, `${denormalize(county)} County`]
    },  [ city, county ])

    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                <h3 className={css.subtitle}><A href={`/c/${county}`}>{countyTitle}</A></h3>
                {
                    years && <>
                        <h2>Yearly stats</h2>
                        <ResultTable
                            className={`${css.crashesTable} ${totals ? css.withTotals : ``}`}
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
            </div>
        </div>
    )
}
