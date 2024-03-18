import { Urls } from "@/src/urls";
import { sqlQuery } from "@/server/sql";
import { Crash, crashesQuery, Total, totalsQuery } from "@/src/use-njsp-crashes";

export function getTotals({ urls, cc, mc, }: { urls: Urls, cc: number | null, mc: number | null }): Promise<Total[]> {
    const query = totalsQuery({ cc, mc, })
    return sqlQuery<Total>({ url: urls.njsp.crashes, query, })
}

export function getCrashes({ urls, cc, mc, page, perPage, }: { urls: Urls, cc: number | null, mc: number | null, page: number, perPage: number }): Promise<Crash[]> {
    const query = crashesQuery({ cc, mc, page, perPage, })
    return sqlQuery<Crash>({ url: urls.njsp.crashes, query, })
}
