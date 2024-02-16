import type { GetStaticProps } from "next";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { getBasePath } from "@rdub/next-base/basePath";
import { useMemo, useState } from "react";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { Col, crashRows, ResultTable, RowsTable, yearRows } from "@/src/result-table";
import { denormalize, normalize } from "@/src/county";
import css from "./city.module.scss"
import A from "@rdub/next-base/a";
import { Crash, Totals } from "@/src/crash";
// import singleton from "@rdub/base/singleton";
import { map, flatMap, fold } from "fp-ts/either";
import { left, right } from "fp-ts/Either";
import { useTotals } from "@/src/use-totals";

export function singleton<T>(ts: T[]): T {
    const set = new Set(ts)
    return (set.size !== 1) ? null : set.values().next().value
}

export type Params = {
    county: string
    city: string
}

export type Urls = {
    crashes: string
    ymc: string
}

export type Props = {
    urls: Urls
    cc: number
    mc: number
} & Params

export type YearStats = {
    y: number
    tk: number
    ti: number
    tv: number
    fc: number
    ic: number
    pc: number
}

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
    const basePath = getBasePath()
    const prefix = process.env['CI'] ? `https://nj-crashes.s3.amazonaws.com/njdot/data` : `${basePath}/njdot`
    const urls = {
        crashes: `${prefix}/crashes.db`,
        ymc: `${prefix}/ycm.db`,
    }
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

    const query = useMemo(
        () => {
            const offset = page * perPage
            return `
                select * from crashes
                where severity='f' and cc=${cc} and mc=${mc}
                order by dt desc
                limit ${perPage} offset ${offset}
            `
        },
        [ page, perPage ]
    )
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    // const ymcRes = useSqlQuery()
    const totals = useTotals({ url: urls.ymc, requestChunkSize, cc, mc })
    const totalsElem = totals && fold(
        (e: Error) => <div className={css.sqlError}>err.toString()</div>,
        ({ tk, ti, tv, fc, ic, pc, }: Totals) => <div>
            <div>{tk.toLocaleString()} deaths</div>
            <div>{ti.toLocaleString()} injuries</div>
            <div>{tv.toLocaleString()} vehicles</div>
            <div>{fc.toLocaleString()} fatal crashes</div>
            <div>{(fc + ic).toLocaleString()} injury crashes</div>
            <div>{(fc + ic + pc).toLocaleString()} property damage crashes</div>
        </div>,
    )(totals)

    const years = useSqlQuery<YearStats>({
        url: urls.ymc, requestChunkSize,
        query: `
            select y,
                   sum(tk) as tk,
                   sum(ti) as ti,
                   sum(tv) as tv,
                   sum(fc) as fc,
                   sum(ic) as ic,
                   sum(pc) as pc
            from ycm group by cc, mc, y
            having cc=${cc} and mc=${mc}
            order by y desc
        `,
    })
    const countyTitle = `${denormalize(county)} County`
    const title = useMemo(() => {
        const cityTitle = denormalize(city)
        return `${cityTitle}`
    },  [ city, county ])
    const cols: Col[] = [ 'dt', 'casualties', 'road', 'cross_street', 'mp', 'll', ]
    // console.log("years:", years)
    const crashesResult = useSqlQuery<Crash>({ url: urls.crashes, requestChunkSize, query })
    const crashes = useMemo(
        () => crashesResult && map((crashes: Crash[]) => crashRows({ rows: crashes, cols }))(crashesResult),
        [ crashesResult, cols ]
    )
    // console.log(`crashes:`, crashes)
    return (
        <div className={css.body}>
            <div className={css.container}>
                <h1 className={css.title}>{title}</h1>
                <h3 className={css.subtitle}><A href={`/c/${county}`}>{countyTitle}</A></h3>
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
            </div>
        </div>
    )
}
