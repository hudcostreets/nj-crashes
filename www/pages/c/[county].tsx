import type { GetStaticProps } from "next";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { getBasePath } from "@rdub/next-base/basePath";
import { useMemo, useState } from "react";
import { Col, CrashTable } from "@/src/crash-table";
import { keys } from "@rdub/base/objs";
import { cc2mc2mn, CountyCodes } from "@/server/county";
import { denormalize, normalize } from "@/src/county";

export const maxBytesToRead = 20 * 1024 * 1024

export type Params = {
    county: string
}

export type Props = {
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
    let { county } = params
    county = normalize(county)
    const cc = CountyCodes[county]
    const mc2mn = cc2mc2mn[cc].mc2mn
    return { props: { county, cc, mc2mn } }
}

export default function CountyPage({ county, cc, mc2mn }: Props) {
    const basePath = getBasePath()

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
    const url = `${basePath}/njdot/crashes.db`
    const [ requestChunkSize, setRequestChunkSize ] = useState<number>(64 * 1024)
    const result = useSqlQuery({ url, requestChunkSize, query, maxBytesToRead })
    const countyTitle = denormalize(county)
    const cols: Col[] = [ 'dt', 'mc', 'casualties', 'road', 'cross_street', 'mp', 'll', ]
    return (
        <div>
            <h1>{countyTitle} County</h1>
            <CrashTable result={result} cols={cols} mc2mn={mc2mn} />
        </div>
    )
}
