import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { getBasePath } from "@/src/lib/basePath"
import { useYearStats, ColTitles, YearStatsDicts, YearStatsDict } from "@/src/use-year-stats"
import { Tooltip } from "@/src/tooltip"
import { fold } from "fp-ts/Either"
import { o2a } from "@rdub/base/objs"
import css from "./year-stats.module.scss"

type YearRow = {
    year: string | number
    key: string
    data: YearStatsDict
}

function buildRows(ysds: YearStatsDicts): YearRow[] {
    const rows = o2a(ysds, (y, data) => ({
        year: y === 'totals' ? 'Total' : y,
        key: String(y),
        data,
    }))
    // o2a iterates numeric keys ascending (JS object key ordering); reverse for newest-first
    // 'totals' key is non-numeric so it comes last from o2a, keep it last
    const totalsIdx = rows.findIndex(r => r.key === 'totals')
    const totals = totalsIdx >= 0 ? rows.splice(totalsIdx, 1) : []
    rows.reverse()
    return [...rows, ...totals]
}

function sumDicts(dicts: YearStatsDict[]): YearStatsDict {
    const sum: YearStatsDict = { k: 0, si: 0, mi: 0, pi: 0, ni: 0, fc: 0, sic: 0, mic: 0, pic: 0, nic: 0 }
    for (const d of dicts) {
        sum.k += d.k; sum.si += d.si; sum.mi += d.mi; sum.pi += d.pi; sum.ni += d.ni
        sum.fc += d.fc; sum.sic += d.sic; sum.mic += d.mic; sum.pic += d.pic; sum.nic += d.nic
    }
    return sum
}

function totalCrashes(d: YearStatsDict) {
    return d.fc + d.sic + d.mic + d.pic + d.nic
}

const columns: { label: string, value: (d: YearStatsDict) => number, tooltip?: string }[] = [
    { label: "Total crashes", value: totalCrashes },
    { label: "Deaths", value: d => d.k },
    { label: "Serious Injuries", value: d => d.si, tooltip: ColTitles["Serious Injuries"] },
    { label: "Minor Injuries", value: d => d.mi, tooltip: ColTitles["Minor Injuries"] },
    { label: "Other Reported Injuries", value: d => d.pi, tooltip: ColTitles["Other Reported Injuries"] },
]

function YearStatsTable({ ysds }: { ysds: YearStatsDicts }) {
    const allRows = useMemo(() => buildRows(ysds), [ysds])
    const dataRows = useMemo(() => allRows.filter(r => r.key !== 'totals'), [allRows])

    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
    const rangeAnchor = useRef<number | null>(null)
    const tableRef = useRef<HTMLTableElement>(null)

    // Click outside table clears selection
    useEffect(() => {
        if (selectedKeys.size === 0) return
        const handler = (e: MouseEvent) => {
            if (tableRef.current && !tableRef.current.contains(e.target as Node)) {
                setSelectedKeys(new Set())
                rangeAnchor.current = null
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [selectedKeys.size])

    const handleRowMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.shiftKey) e.preventDefault()
    }, [])

    const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
        const key = dataRows[index].key
        if (e.metaKey || e.ctrlKey) {
            setSelectedKeys(prev => {
                const next = new Set(prev)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
            })
            rangeAnchor.current = index
        } else if (e.shiftKey && rangeAnchor.current !== null) {
            const lo = Math.min(rangeAnchor.current, index)
            const hi = Math.max(rangeAnchor.current, index)
            setSelectedKeys(prev => {
                const next = new Set(prev)
                for (let i = lo; i <= hi; i++) {
                    next.add(dataRows[i].key)
                }
                return next
            })
        } else {
            if (selectedKeys.size === 1 && selectedKeys.has(key)) {
                setSelectedKeys(new Set())
                rangeAnchor.current = null
            } else {
                setSelectedKeys(new Set([key]))
                rangeAnchor.current = index
            }
        }
    }, [dataRows, selectedKeys])

    const summaryData = useMemo(() => {
        if (selectedKeys.size > 1) {
            const selectedDicts = dataRows
                .filter(r => selectedKeys.has(r.key))
                .map(r => r.data)
            return sumDicts(selectedDicts)
        }
        return allRows.find(r => r.key === 'totals')?.data ?? sumDicts(dataRows.map(r => r.data))
    }, [selectedKeys, dataRows, allRows])

    const summaryLabel = selectedKeys.size > 1
        ? `${selectedKeys.size} years`
        : 'Total'

    return (
        <div className={css.wrapper}>
            <table className={css.table} ref={tableRef}>
                <thead>
                    <tr>
                        <th className={css.yearCol}>Year</th>
                        {columns.map(col =>
                            <th key={col.label} className={css.numCol}>
                                {col.tooltip
                                    ? <Tooltip title={col.tooltip} arrow><span className={css.noselect}>{col.label}</span></Tooltip>
                                    : <span className={css.noselect}>{col.label}</span>
                                }
                            </th>
                        )}
                    </tr>
                    <tr className={css.totalRow}>
                        <td className={css.yearCol}>{summaryLabel}</td>
                        {columns.map(col =>
                            <td key={col.label} className={css.numCol}>
                                {col.value(summaryData).toLocaleString()}
                            </td>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {dataRows.map((row, idx) => {
                        const selected = selectedKeys.has(row.key)
                        return (
                            <tr
                                key={row.key}
                                className={selected ? css.selected : ''}
                                onMouseDown={handleRowMouseDown}
                                onClick={e => handleRowClick(e, idx)}
                            >
                                <td className={css.yearCol}>{row.year}</td>
                                {columns.map(col =>
                                    <td key={col.label} className={css.numCol}>
                                        {col.value(row.data).toLocaleString()}
                                    </td>
                                )}
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

export function YearStatsSection() {
    const { cc, mc } = useGeoFilter()
    const url = `${getBasePath()}/njdot/cmymc.db`
    const result = useYearStats({ cc, mc, url })
    if (!result) return <p>Loading annual statistics...</p>
    return fold(
        (err: Error) => <div><p>Error loading statistics: {err.message}</p></div>,
        (ysds: YearStatsDicts) => <YearStatsTable ysds={ysds} />
    )(result)
}
