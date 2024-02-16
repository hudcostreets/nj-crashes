import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { useMemo } from "react";
import { Totals } from "@/src/crash";
import { Either } from "fp-ts/Either";

export type YearStats = {
    y: number
    tk: number
    ti: number
    tv: number
    fc: number
    ic: number
    pc: number
}

export type Props = {
    url: string
    requestChunkSize: number
    cc: number
    mc?: number
}

export function useYearStats({ url, requestChunkSize, cc, mc, }: Props) {
    const query = useMemo(
        () => {
            const sums = [ 'tk', 'ti', 'tv', 'fc', 'ic', 'pc' ].map(c => `sum(${c}) as ${c}`).join(', ')
            const groupBy = `group by cc${mc ? `, mc` : ``}, y`
            const having = `having cc=${cc}${mc ? ` and mc=${mc}` : ""}`
            return `
                select y, ${sums}
                from ycm ${groupBy}
                ${having}
                order by y desc
            `
        },
        [ cc, mc ]
    )
    return useSqlQuery<YearStats>({ url, requestChunkSize, query, })
}
