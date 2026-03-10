import { useMemo } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { getUrls } from "@/src/urls"
import { DOTEnd } from "@/src/constants"
import { useDatePaginationControls } from "@/src/pagination"
import { useNjdotCrashRows } from "@/src/use-njdot-crashes"
import { ResultTable } from "@/src/result-table"

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

    if (!cc2mc2mn) return <p>Loading crash data...</p>
    if (!crashRows) return <p>Loading crash data...</p>

    const pagination = { before, setBefore, start, end, perPage, setPerPage, total: 0 }

    return (
        <ResultTable
            result={crashRows}
            pagination={pagination}
        />
    )
}
