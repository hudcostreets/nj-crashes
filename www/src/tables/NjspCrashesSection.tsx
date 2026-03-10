import { useMemo } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { getUrls } from "@/src/urls"
import { usePaginationControls, Pagination } from "@/src/pagination"
import { useNjspCrashRows, useNjspCrashesTotal, Total } from "@/src/use-njsp-crashes"
import { ResultTable } from "@/src/result-table"
import { fold } from "fp-ts/Either"

export function NjspCrashesSection() {
    const { cc, mc, cc2mc2mn } = useGeoFilter()
    const urls = useMemo(() => getUrls(), [])
    const { page, setPage, perPage, setPerPage } = usePaginationControls({ id: "njsp-crashes", perPage: 20 })

    const totalsResult = useNjspCrashesTotal({ cc, mc, urls, totals: [{ total: 0 }] })
    const total = useMemo(
        () => fold(
            () => 0,
            (totals: Total[]) => totals[0]?.total ?? 0,
        )(totalsResult),
        [totalsResult],
    )
    const pagination: Pagination | undefined = useMemo(
        () => total > 0 ? { page, setPage, perPage, setPerPage, total } : undefined,
        [page, setPage, perPage, setPerPage, total],
    )

    const crashRows = useNjspCrashRows({
        cc, mc, page, perPage, urls,
        cc2mc2mn: cc2mc2mn ?? {},
        crashes: [],
    })

    if (!cc2mc2mn) return <p>Loading crash data...</p>

    return (
        <ResultTable
            result={crashRows}
            pagination={pagination}
            className="compact"
        />
    )
}
