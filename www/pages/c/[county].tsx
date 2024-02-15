import type { GetStaticProps } from "next";
import { fromEntries } from "@rdub/base/objs";
import { useSqlQuery } from "@/src/sqlQuery";
import { getBasePath } from "@rdub/next-base/basePath";
import { Result } from "@/src/sql/result";
import { useMemo, useState } from "react";
import { loadSync } from "@rdub/base/load";

export type Params = {
    county: string
}

export type Props = {
    cc: number
    mc2mn: { [mc: number]: string }
} & Params

const Counties = [
    'atlantic',
    'bergen',
    'burlington',
    'camden',
    'cape may',
    'cumberland',
    'essex',
    'gloucester',
    'hudson',
    'hunterdon',
    'mercer',
    'middlesex',
    'monmouth',
    'morris',
    'ocean',
    'passaic',
    'salem',
    'somerset',
    'sussex',
    'union',
    'warren',
]
const CountyCodes = fromEntries(
    Counties.map((county, idx) => [ county, idx + 1 ])
)

export function getStaticPaths() {
    const paths = Counties.map(county => ({ params: { county } }))
    return { paths, fallback: false }
}

export const getStaticProps: GetStaticProps<Props, Params> = async ({ params }) => {
    if (!params) {
        return { notFound: true }
    }
    const cc2mc2mn = loadSync('public/njdot/cc2mc2mn.json') as any
    let { county } = params
    county = county.toLowerCase()
    const cc = CountyCodes[county]
    const mc2mn = cc2mc2mn[cc].mc2mn
    return { props: { county, cc, mc2mn } }
}

export const titleCase = (s: string) => s.split(' ').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')

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
    const url = `${basePath}/crashes.db`
    const result = useSqlQuery({ url, query })
    const countyTitle = titleCase(county)

    return (
        <div>
            <h1>{countyTitle} County</h1>
            <Result result={result} mc2mn={mc2mn} />
        </div>
    )
}
