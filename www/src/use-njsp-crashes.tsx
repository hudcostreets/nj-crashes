import { Result, useApi, useApiEager, apiUrl } from "@/src/api";
import { ReactNode, useMemo } from "react";
import { CC2MC2MN } from "@/src/county";
import { map } from "fp-ts/Either";

import { Row } from "@/src/result-table";
import { fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import strftime from "strftime";
import css from "@/src/use-crashes.module.scss";
import { Cyclist, Driver, Passenger, Pedestrian, Person } from "@/src/icons";
import { fadeColor } from "pltly";
import { Tooltip } from "@/src/tooltip";
import CityLink from "@/src/city-link";
import CountyLink from "@/src/county-link";
import { curYear } from "@/src/constants";

export type Props = {
    cc: number | null
    cn?: string
    mc: number | null
    page: number
    perPage: number
    /** Inclusive lower bound on crash year. `null`/omitted = no lower bound. */
    yearFrom?: number | null
    /** Inclusive upper bound on crash year. `null`/omitted = no upper bound. */
    yearTo?: number | null
    /** Victim-type filter: single-char codes joined (e.g. `"de"` for
     *  drivers+pedestrians). `null`/omitted/all-4 = no filter. */
    types?: string | null
}

export type Crash = {
    id: number
    cc: number
    mc: number
    dt: string
    tk: number
    ti: number
    dk: number
    ok: number
    pk: number
    bk: number
    location: string
    street: string
    highway: string
}

export const ColLabels = {
    id: "ID",
    date: "Date",
    time: "Time",
    dt: "Date/Time",
    cc: "County",
    mc: "Municipality",
    casualties: "Casualties",
    location: "Location",
    street: "Street",
    highway: "Highway",
}
export type Col = keyof typeof ColLabels

export type Total = { total: number }

export function useNjspCrashesTotal({
    cc, mc, yearFrom, yearTo, types,
}: {
    cc: number | null,
    mc: number | null,
    yearFrom?: number | null,
    yearTo?: number | null,
    types?: string | null,
}): Result<Total> {
    const url = useMemo(
        () => apiUrl("/njsp/crashes/count", { cc, mc, yearFrom, yearTo, types }),
        [cc, mc, yearFrom, yearTo, types],
    )
    return useApiEager<Total>(url, [{ total: 0 }])
}

export function useNjspCrashes({ cc, mc, page, perPage, yearFrom, yearTo, types }: Props): Result<Crash> {
    const offset = page * perPage
    const url = useMemo(
        () => apiUrl("/njsp/crashes", { cc, mc, limit: perPage, offset, yearFrom, yearTo, types }),
        [cc, mc, perPage, offset, yearFrom, yearTo, types],
    )
    return useApiEager<Crash>(url, [])
}

// Match colors from FatalitiesPerYearPlot (the plot directly above this table)
const driverColor = '#a94c9a'
const passengerColor = '#f08030'
const pedestrianColor = '#d85a6a'
const cyclistColor = '#7c5295'
const unknownColor = '#7F7F7F'
const injuryFadedUnknown = fadeColor(unknownColor)

export function CrashIcons({ tk, dk, ok, pk, bk, ti, }: Crash) {
    const uk = tk - dk - ok - pk - bk
    return (
        <div className={css.icons}>
            <span className={css.typeIcons}>
                {range(dk).map(idx => <Driver key={`dk${idx}`} title={"Driver killed"} style={{ fill: driverColor }} />)}
                {range(ok).map(idx => <Passenger key={`ok${idx}`} title={"Passenger killed"} style={{ fill: passengerColor }} />)}
                {range(pk).map(idx => <Pedestrian key={`pk${idx}`} title={"Pedestrian killed"} style={{ fill: pedestrianColor }} />)}
                {range(bk).map(idx => <Cyclist key={`bk${idx}`} title={"Cyclist killed"} style={{ fill: cyclistColor }} />)}
                {range(uk).map(idx => <Person key={`uk${idx}`} title={"Person killed"} style={{ fill: unknownColor }} />)}
                {range(ti).map(idx => <Person key={`ti${idx}`} title={"Person injured"} style={{ fill: injuryFadedUnknown }} />)}
            </span>
        </div>
    )
}

export function getNjspCrashRows({ rows, cols, cc2mc2mn, }: {
    rows: Crash[]
    cols: Col[]
    cc2mc2mn: CC2MC2MN
}): Row[] {
    return rows.map(row => {
        const { id } = row
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode = ''
                if (col == 'date') {
                    const date = new Date(row.dt)
                    const fmt = date.getFullYear() == curYear ? '%a %b %-d' : `%-m/%-d/%y`
                    txt = <Tooltip title={`NJSP ACCID: ${id}`}>
                        <span>{strftime(fmt, date)}</span>
                    </Tooltip>
                } else if (col == 'time') {
                    const date = new Date(row.dt)
                    txt = strftime('%-I:%M%p', date)
                } else if (col == 'dt') {
                    const date = new Date(row.dt)
                    const fmt = date.getFullYear() == curYear ? '%a %b %-d %-I:%M%p' : `%-m/%-d/%y %-I:%M%p`
                    txt = <Tooltip title={`NJSP ACCID: ${id}`}>
                        <span>{strftime(fmt, date)}</span>
                    </Tooltip>
                } else if (col == 'casualties') {
                    txt = <CrashIcons {...row} />
                } else if (col == 'cc') {
                    txt = <CountyLink cc={row.cc} cc2mc2mn={cc2mc2mn} />
                } else if (col == 'mc') {
                    txt = <CityLink {...row} cc2mc2mn={cc2mc2mn} />
                } else {
                    txt = row[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}

export function useNjspCrashRows({ cc2mc2mn, ...props }: Props & { cc2mc2mn: CC2MC2MN }) {
    const crashesResult = useNjspCrashes(props)
    const ccCol: Col[] = props.cc ? [] : ['cc']
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'date', 'time', ...ccCol, ...mcCol, 'casualties', 'location', ]
    const crashRows = useMemo(
        () => {
            const crashRows = map(
                (crashes: Crash[]) => getNjspCrashRows({ rows: crashes, cols, cc2mc2mn, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, ]
    )
    return crashRows
}
