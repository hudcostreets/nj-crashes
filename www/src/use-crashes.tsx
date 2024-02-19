import { ReactNode, useMemo } from "react";
import * as sql from "@rdub/react-sql.js-httpvfs/query";
import { Result } from "@rdub/react-sql.js-httpvfs/query";
import { useSqlQuery } from "@/src/sql";
import { Crash } from "@/src/crash";
import { Row } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { MC2MN } from "@/src/county";
import strftime from "strftime";
import { entries, fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import { Urls } from "@/src/urls";
import { Car, Cyclist, Driver, Passenger, Pedestrian } from "@/src/icons";
import css from "./use-crashes.module.scss"
import { CrashesOccStats, CrashOccStats, useOccupantStats } from "@/src/occ-stats";
import { CrashesPedStats, CrashPedStats, usePedestrianStats } from "@/src/ped-stats";
import { CrashesVehicles, useCrashVehicles, Vehicle } from "@/src/crash-vehicles";

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

const CarDamageMap = [
    { title: 'Vehicle damage unknown', fill: '#777' },
    { title: 'Vehicle undamaged', fill: 'green' },
    { title: 'Vehicle sustained minor damage', fill: 'orange' },
    { title: 'Vehicle sustained moderate damage', fill: '#d00' },
    { title: 'Vehicle disabled', fill: 'black' },
]

const CarDepartureMap = [
    'Unknown departure status',
    'driven away',
    'left at scene',
    'towed (disabled)',
    'towed (impounded)',
    'towed (disabled + impounded)',
]

export function CrashIcons(
    {
        dk, di,
        ok, oi,
        pk, pi,
        bk, bi,
        vehicles,
    }: Omit<CrashOccStats, 'crash_id'> &
        Omit<CrashPedStats, 'crash_id'> & { vehicles?: Vehicle[] }
) {
    const tk = dk + ok + pk + bk
    const ti = di + oi + pi + bi
    return <div className={css.icons}>
        {tk ? <span className={css.typeIcons}>
            <span className={css.typeIcon}>⚰️</span>
            {dk ? range(dk).map(i => <Driver key={i} />) : null}
            {ok ? range(ok).map(i => <Passenger key={i} />) : null}
            {pk ? range(pk).map(i => <Pedestrian key={i} />) : null}
            {bk ? range(bk).map(i => <Cyclist key={i} />) : null}
        </span> : null}
        {ti ? <span className={css.typeIcons}>
            <span className={css.typeIcon}>🏥</span>
            {di ? range(di).map(i => <Driver key={i} />) : null}
            {oi ? range(oi).map(i => <Passenger key={i} />) : null}
            {pi ? range(pi).map(i => <Pedestrian key={i} />) : null}
            {bi ? range(bi).map(i => <Cyclist key={i} />) : null}
        </span> : null}
        {
            vehicles?.length
                ? <span className={css.typeIcons}>
                    {/*<span className={css.typeIcon}>🚗</span>*/}
                    {
                        vehicles.map(
                            ({ damage, damage_loc, impact_loc, departure }, i) => {
                                damage = damage ?? 0
                                const disabled = damage === 4 || departure === 3 || departure === 5
                                if (disabled) damage = 4
                                const towed = departure >= 3
                                const impounded = departure === 4 || departure === 5
                                let { title } = CarDamageMap[damage]
                                let { fill } = CarDamageMap[disabled || towed || impounded ? 4 : damage]
                                if (towed) title += ', towed'
                                if (impounded) title += ', impounded'
                                // title += ` (${CarDepartureMap[departure]})`
                                return <Car
                                    key={i}
                                    style={{ fill }}
                                    title={title}
                                />
                                // <span key={i} className={css.typeIcon}>🚗</span>
                            }
                        )
                    }
                </span>
                : null
        }
    </div>
}

export function getCrashRows({ rows, cols, mc2mn, occStats, pedStats, crashVehicles, }: {
    rows: Crash[]
    cols: Col[]
    mc2mn?: MC2MN
    occStats: CrashesOccStats | null
    pedStats: CrashesPedStats | null
    crashVehicles: CrashesVehicles | null
}): Row[] {
    return rows.map(row => {
        const { id } = row
        const occStat = occStats?.[id]
        const pedStat = pedStats?.[id]
        const vehicles = crashVehicles?.[id]
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
                    const { dk = 0, di = 0, ok = 0, oi = 0, } = occStat ?? {}
                    const { pk = 0, pi = 0, bk = 0, bi = 0 } = pedStat ?? {}
                    txt = <CrashIcons
                        dk={dk} di={di}
                        ok={ok} oi={oi}
                        pk={pk} pi={pi}
                        bk={bk} bi={bi}
                        vehicles={vehicles}
                    />
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
    const pedStats = usePedestrianStats({ crashesResult, ...props })
    const crashVehicles = useCrashVehicles({ crashesResult, ...props })
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'road', 'cross_street', 'mp', 'll', ]

    const crashRows = useMemo(
        () => {
            if (!crashesResult) return
            console.log("crashRows effect")
            const crashRows = map(
                (crashes: Crash[]) => getCrashRows({ rows: crashes, cols, mc2mn, occStats, pedStats, crashVehicles, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, occStats, ]
    )
    return crashRows
}
