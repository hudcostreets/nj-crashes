import { useMemo } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { getUrls } from "@/src/urls"
import { DOTEnd } from "@/src/constants"
import { useDatePaginationControls } from "@/src/pagination"
import { useNjdotCrashRows, useNjdotCrashesTotal, Total } from "@/src/use-njdot-crashes"
import { ResultTable } from "@/src/result-table"
import { fold } from "fp-ts/Either"

export function NjdotCrashesSection() {
    const { cc, mc, cc2mc2mn } = useGeoFilter()
    const urls = useMemo(() => getUrls(), [])
    const { before, setBefore, perPage, setPerPage, start, end } = useDatePaginationControls(
        { id: "njdot-crashes" },
        { end: DOTEnd },
    )

    const crashRows = useNjdotCrashRows({
        cc, mc, before, perPage, urls,
        cc2mc2mn: cc2mc2mn ?? {},
    })

    const totalsResult = useNjdotCrashesTotal({ cc, mc, before, urls, totals: [{ total: 0 }] })
    const total = useMemo(
        () => fold(
            () => 0,
            (totals: Total[]) => totals[0]?.total ?? 0,
        )(totalsResult),
        [totalsResult],
    )

    if (!cc2mc2mn) return <p>Loading crash data...</p>
    if (!crashRows) return <p>Loading crash data...</p>

    const pagination = { before, setBefore, start, end, perPage, setPerPage, total }

    return (
        <ResultTable
            result={crashRows}
            pagination={pagination}
        />
    )
}
