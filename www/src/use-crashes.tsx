import { ReactNode, useMemo } from "react";
import * as sql from "@rdub/react-sql.js-httpvfs/query";
import { Result } from "@rdub/react-sql.js-httpvfs/query";
import { useSqlQuery } from "@/src/sql";
import { Crash } from "@/src/crash";
import { Row } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { MC2MN } from "@/src/county";
import strftime from "strftime";
import { fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import { Urls } from "@/src/urls";
import { Car, Cyclist, Driver, Passenger, Pedestrian } from "@/src/icons";
import css from "./use-crashes.module.scss"
import { CrashesOccupants, Occupant, useCrashOccupants } from "@/src/crash-occupants";
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

const unknown = "#777"
const red = "#d00"

const CarDamageMap = [
    { title: 'Vehicle damage unknown', fill: unknown },
    { title: 'Vehicle undamaged', fill: 'green' },
    { title: 'Vehicle sustained minor damage', fill: 'orange' },
    { title: 'Vehicle sustained moderate damage', fill: red },
    { title: 'Vehicle disabled', fill: 'black' },
]

const ConditionMap = [
    { txt: "condition unknown", fill: unknown, },
    { txt: "deceased", fill: 'black', },
    { txt: "serious injury", fill: red, },
    { txt: "moderate injury", fill: "orange", },
    { txt: "possible injury", fill: "#8B8000", },
]

export function CrashIcons(
    {
        occupants,
        pk, pi,
        bk, bi,
        vehicles,
    }: {
        occupants?: Occupant[]
        vehicles?: Vehicle[]
    } & Omit<CrashPedStats, 'crash_id'>
) {
    const tk = pk + bk
    const ti = pi + bi
    const deaths = [] as ReactNode[]
    const seriousInjuries = [] as ReactNode[]
    const moderateInjuries = [] as ReactNode[]
    const possibleInjuries = [] as ReactNode[]
    const arrs = [ [], deaths, seriousInjuries, moderateInjuries, possibleInjuries, ]
    occupants?.forEach(({ pos, condition, eject, age, sex, inj_loc, inj_type, }, idx) => {
        condition = condition ?? 0
        let ejectedStr: string = ""
        switch (eject) {
            case 2: ejectedStr = "partially ejected"; break
            case 3: ejectedStr = "ejected"; break
            case 4: ejectedStr = "trapped"; break
        }
        const [ type, Component, ] =
            pos === 1
                ? [ 'Driver', Driver, ]
                : [ 'Passenger', Passenger, ]
        const { txt, fill } = ConditionMap[condition]
        let title = `${type} ${txt}${ejectedStr ? `, ${ejectedStr}` : ''}`
        const icon = <Component key={idx} title={title} style={{ fill }} />
        arrs[condition].push(icon)
    })
    return <div className={css.icons}>
        {tk || deaths.length ? <span className={css.typeIcons}>
            {/*<span className={css.typeIcon}>⚰️</span>*/}
            {deaths}
            {pk ? range(pk).map(i => <Pedestrian key={i} />) : null}
            {bk ? range(bk).map(i => <Cyclist key={i} />) : null}
        </span> : null}
        {ti || seriousInjuries.length ? <span className={css.typeIcons}>
            {/*<span className={css.typeIcon}>🏥</span>*/}
            {seriousInjuries}
            {pi ? range(pi).map(i => <Pedestrian key={i} />) : null}
            {bi ? range(bi).map(i => <Cyclist key={i} />) : null}
        </span> : null}
        {moderateInjuries.length ? <span className={css.typeIcons}>
            {/*<span className={css.typeIcon}>🩹</span>*/}
            {moderateInjuries}
        </span> : null}
        {possibleInjuries.length ? <span className={css.typeIcons}>
            {/*<span className={css.typeIcon}>🤕</span>*/}
            {possibleInjuries}
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
                                const drivenAway = departure === 1
                                const leftAtScene = departure === 2
                                let { title } = CarDamageMap[damage]
                                let { fill } = CarDamageMap[disabled || towed || impounded ? 4 : damage]
                                if (drivenAway) title += ', driven away'
                                if (leftAtScene) title += ', left at scene'
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

export function getCrashRows({ rows, cols, mc2mn, crashOccupants, pedStats, crashVehicles, }: {
    rows: Crash[]
    cols: Col[]
    mc2mn?: MC2MN
    crashOccupants: CrashesOccupants | null
    pedStats: CrashesPedStats | null
    crashVehicles: CrashesVehicles | null
}): Row[] {
    return rows.map(row => {
        const { id } = row
        const occupants = crashOccupants?.[id]
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
                    const { pk = 0, pi = 0, bk = 0, bi = 0 } = pedStat ?? {}
                    txt = <CrashIcons
                        pk={pk} pi={pi}
                        bk={bk} bi={bi}
                        occupants={occupants}
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
    const crashOccupants = useCrashOccupants({ crashesResult, ...props })
    const pedStats = usePedestrianStats({ crashesResult, ...props })
    const crashVehicles = useCrashVehicles({ crashesResult, ...props })
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'road', 'cross_street', 'mp', 'll', ]

    const crashRows = useMemo(
        () => {
            if (!crashesResult) return
            console.log("crashRows effect")
            const crashRows = map(
                (crashes: Crash[]) => getCrashRows({ rows: crashes, cols, mc2mn, crashOccupants: crashOccupants, pedStats, crashVehicles, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, crashOccupants, ]
    )
    return crashRows
}
