import type { GetStaticProps } from "next";
import { fromEntries } from "@rdub/base/objs";
import { useSqlQuery } from "@/src/sqlQuery";
import { getBasePath } from "@rdub/next-base/basePath";
import { Result } from "@/src/sql/result";
import { useMemo, useState } from "react";

export type Params = {
    county: string
}

export type Props = {
    cc: number
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
    let { county } = params
    county = county.toLowerCase()
    const cc = CountyCodes[county]
    return { props: { county, cc } }
}

export const titleCase = (s: string) => s.split(' ').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')

export default function CountyPage({ county, cc }: Props) {
    const basePath = getBasePath()

    const [ perPage, setPerPage ] = useState<number>(25)
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
            <Result result={result} />
        </div>
    )
}
