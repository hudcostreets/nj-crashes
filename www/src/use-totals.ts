import { Totals } from "@/src/crash";
import { useMemo } from "react";
import { Either, flatMap, left, right } from "fp-ts/Either";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";

export type Props = {
    url: string
    requestChunkSize: number
    cc: number
    mc?: number
}

export function useTotals({ url, requestChunkSize, cc, mc }: Props): Either<Error, Totals> | null {
    const query = useMemo(
        () => {
            const select = `select cc,${mc ? ` mc,` : ``}`
            const having = `having cc=${cc} ${mc ? `and mc=${mc}` : ""}`
            const sums = [ 'tk', 'ti', 'tv', 'fc', 'ic', 'pc' ].map(c => `sum(${c}) as ${c}`).join(',\n\t')
            const from = `from ycm group by cc${mc ? `, mc` : ``}`
            return `
                ${select}
                ${sums}
                ${from}
                ${having}
            `
        },
        [ cc, mc ]
    )
    const totalsRes = useSqlQuery<Totals>({
        url, requestChunkSize,
        query,
    })
    return useMemo(
        () => totalsRes && flatMap(
            totalsRes,
            r =>
                r.length === 1
                    ? right(r[0])
                    : left(Error(``))
        ),
        [ totalsRes ]
    )
}
