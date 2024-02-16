import { useMemo } from "react";
import { useSqlQuery } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { Col, crashRows } from "@/src/result-table";
import { map } from "fp-ts/Either";

export type Props = {
    url: string
    requestChunkSize: number
    cc: number
    mc?: number
    page: number
    perPage: number
}

export function useCrashes({ url, requestChunkSize, cc, mc, page, perPage, }: Props) {
    const query = useMemo(
        () => {
            const offset = page * perPage
            return `
                select * from crashes
                where severity='f' and cc=${cc}${mc ? ` and mc=${mc}` : ""}
                order by dt desc
                limit ${perPage} offset ${offset}
            `
        },
        [ page, perPage ]
    )
    return useSqlQuery<Crash>({ url, requestChunkSize, query })
}

export function useCrashRows({ mc2mn, ...props }: Props & { mc2mn?: { [mc: number]: string } }) {
    const crashesResult = useCrashes(props)
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'road', 'cross_street', 'mp', 'll', ]
    const crashes = useMemo(
        () => crashesResult && map((crashes: Crash[]) => crashRows({ rows: crashes, cols, mc2mn, }))(crashesResult),
        [ crashesResult, cols ]
    )
    return crashes
}
