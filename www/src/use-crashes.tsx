import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import * as sql from "@rdub/react-sql.js-httpvfs/query";
import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { useSqlQuery } from "@/src/sql";
import { Crash } from "@/src/crash";
import { Row } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { MC2MN } from "@/src/county";
import strftime from "strftime";
import { entries, fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import { fold } from "fp-ts/either";
import { Urls } from "@/src/urls";
import { Driver, Passenger } from "@/src/icons";
import css from "./use-crashes.module.scss"

export type Base = Omit<sql.Base, 'url'> & {
    urls: Urls
}

export type Props = Base & {
    cc: number
    mc?: number
    page: number
    perPage: number
}

export function useCrashes({ cc, mc, page, perPage, timerId = "crashes", urls, ...base }: Props): Result<Crash> | null {
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
    return useSqlQuery<Crash>({ ...base, url: urls.crashes, timerId, query })
}

export type CrashOccStats = {
    crash_id: number
    dk: number
    di: number
    ok: number
    oi: number
}

export type CrashesOccStats = { [crash_id: number]: CrashOccStats }

export function useOccupantStats({ crashesResult, urls, ...props }: { crashesResult: Result<Crash> | null } & Base): CrashesOccStats | null {
    const [ occStats, setOccStats ] = useState<CrashesOccStats | null>(null)
    const fetchOccStats = useSqlQueryCallback<CrashOccStats>({ url: urls.occupants, ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("occstats effect")
            map(
                (crashes: Crash[]) => {
                    const crashIds = crashes.map(({ id }) => id)
                    const query = `
                        select
                            crash_id,
                            sum(case when condition=1 and pos=1 then 1 else 0 end) as dk,
                            sum(case when condition>1 and condition<5 and pos=1 then 1 else 0 end) as di,
                            sum(case when condition=1 and pos>1 then 1 else 0 end) as ok,
                            sum(case when condition>1 and condition<5 and pos>1 then 1 else 0 end) as oi
                        from occupants
                        where crash_id in (${crashIds.join(', ')})
                        group by crash_id
                    `
                    console.log("Fetching occStats")
                    fetchOccStats(query)?.then(occStats => {
                        fold(
                            err => {
                                console.error("error fetching occ stats:", err)
                                return null
                            },
                            (occStats: CrashOccStats[]) => {
                                console.log("occStats:", occStats)
                                setOccStats(fromEntries(occStats.map(occStat => [ occStat.crash_id, occStat ])))
                            }
                        )(occStats)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchOccStats ]
    )
    return occStats
}

export const ColLabels = {
    id: "ID",
    dt: "Date/Time",
    mc: "City",
    casualties: "Casualties",
    road: "Road",
    cross_street: "Cross Street",
    mp: "MP",
    ll: "Lat, Lon",
    tk: "Fatalities",
    ti: "Injuries",
    tv: "Vehicles",
}
export type Col = keyof typeof ColLabels

export function CrashIcons({ dk, di, ok, oi, }: Omit<CrashOccStats, 'crash_id'>) {
    const tk = dk + ok
    const ti = di + oi
    return <div className={css.icons}>
        {tk ? <span className={css.typeIcons}>
            <span className={css.typeIcon}>⚰️</span>
            {dk ? range(dk).map(i => <Driver key={i} />) : null}
            {ok ? range(ok).map(i => <Passenger key={i} />) : null}
        </span> : null}
        {ti ? <span className={css.typeIcons}>
            <span className={css.typeIcon}>🏥</span>
            {di ? range(di).map(i => <Driver key={i} />) : null}
            {oi ? range(oi).map(i => <Passenger key={i} />) : null}
        </span> : null}
    </div>
}

export function getCrashRows({ rows, cols, mc2mn, occStats, }: {
    rows: Crash[]
    cols: Col[]
    mc2mn?: MC2MN
    occStats: CrashesOccStats | null
}): Row[] {
    return rows.map(row => {
        const { id } = row
        const occStat = occStats?.[id]
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode = ''
                if (col == 'dt') {
                    txt = strftime('%-m/%-d/%-y %-I:%M%p', new Date(row.dt))
                } else if (col == 'll') {
                    const { ilat, ilon, olat, olon } = row
                    const [ lat, lon ] = ilat && ilon ? [ ilat, ilon ] : [ olat, olon ]
                    txt = (lat && lon)
                        ? `${lat?.toFixed(6)}, ${lon?.toFixed(6)}`
                        : ''
                } else if (col == 'casualties') {
                    const os =
                        entries<string, number>(occStat ?? {})
                            .filter(([ k, v ]) => k != 'crash_id' && v > 0)
                    const { dk = 0, di = 0, ok = 0, oi = 0, } = occStat ?? {}
                    txt = <CrashIcons dk={dk} di={di} ok={ok} oi={oi} />
                } else if (col == 'mc') {
                    const { mc } = row
                    if (!mc2mn) {
                        throw new Error('`mc2mn` is required for `mc` col')
                    }
                    txt = mc2mn[mc]
                } else if (col == 'mp') {
                    txt = row.mp?.toFixed(2) ?? ''
                } else {
                    txt = row[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}

export function useCrashRows({ mc2mn, ...props }: Props & { mc2mn?: MC2MN }) {
    const crashesResult = useCrashes({ ...props })
    const occStats = useOccupantStats({ crashesResult, ...props })
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'road', 'cross_street', 'mp', 'll', ]

    const crashRows = useMemo(
        () => {
            if (!crashesResult) return
            console.log("crashRows effect")
            const crashRows = map(
                (crashes: Crash[]) => getCrashRows({ rows: crashes, cols, mc2mn, occStats })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, occStats, ]
    )
    return crashRows
}
