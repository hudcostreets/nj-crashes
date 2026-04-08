import { useMemo } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { usePaginationControls, Pagination } from "@/src/pagination"
import { useNjspCrashRows, useNjspCrashesTotal, Total } from "@/src/use-njsp-crashes"
import { ResultTable } from "@/src/result-table"
import { fold } from "fp-ts/Either"

export function NjspCrashesSection({ perPage: perPageProp, hidePagination }: { perPage?: number; hidePagination?: boolean } = {}) {
    const { cc, mc, cc2mc2mn } = useGeoFilter()
    const { page, setPage, perPage: defaultPerPage, setPerPage } = usePaginationControls({ id: "njsp-crashes", perPage: perPageProp ?? 20 })
    const perPage = perPageProp ?? defaultPerPage

    const totalsResult = useNjspCrashesTotal({ cc, mc })
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
        cc, mc, page, perPage,
        cc2mc2mn: cc2mc2mn ?? {},
    })

    if (!cc2mc2mn) return <p>Loading crash data...</p>

    return (
        <ResultTable
            result={crashRows}
            pagination={hidePagination ? undefined : pagination}
            className="compact"
        />
    )
}
