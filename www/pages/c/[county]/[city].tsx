import type { GetStaticProps } from "next";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { concat, mapEntries, values } from "@rdub/base/objs";
import { getBasePath } from "@rdub/next-base/basePath";
import { useMemo, useState } from "react";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { Col, CrashTable } from "@/src/crash-table";
import { denormalize, normalize } from "@/src/county";

export type Params = {
    county: string
    city: string
}

export type Props = {
    cc: number
    mc: number
    // mc2mn: { [mc: number]: string }
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
    let { county, city, } = params
    county = normalize(county)
    city = normalize(city)
    const cc = CountyCodes[county]
    const mc2mn = mapEntries(cc2mc2mn[cc].mc2mn, (mc, mn) => [ normalize(mn), mc ])
    const mc = mc2mn[city]
    return { props: { county, city, cc, mc } }
}

export default function CityPage({ county, city, cc, mc }: Props) {
    const basePath = getBasePath()

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
    const url = `${basePath}/njdot/crashes.db`
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    const result = useSqlQuery({ url, requestChunkSize, query })
    const title = useMemo(() => {
        const cityTitle = denormalize(city)
        const countyTitle = denormalize(county)
        return `${cityTitle} (${countyTitle} County)`
    },  [ city, county ])
    const cols: Col[] = [ 'dt', 'casualties', 'road', 'cross_street', 'mp', 'll', ]
    return (
        <div>
            <h1>{title}</h1>
            <CrashTable result={result} cols={cols} />
        </div>
    )
}
