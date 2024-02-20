import { ReactNode, useMemo } from "react";
import * as sql from "@rdub/react-sql.js-httpvfs/query";
import { Result } from "@rdub/react-sql.js-httpvfs/query";
import { useSqlQuery } from "@/src/sql";
import { Crash } from "@/src/crash";
import { Row } from "@/src/result-table";
import { map } from "fp-ts/Either";
import { County, normalize } from "@/src/county";
import strftime from "strftime";
import { fromEntries } from "@rdub/base/objs";
import { Urls } from "@/src/urls";
import { Car, Cyclist, Driver, Passenger, Pedestrian as Ped } from "@/src/icons";
import css from "./use-crashes.module.scss"
import { CrashesOccupants, Occupant, useCrashOccupants } from "@/src/crash-occupants";
import { CrashesPedestrians, Pedestrian, useCrashPedestrians } from "@/src/crash-pedestrians";
import { CrashesVehicles, useCrashVehicles, Vehicle } from "@/src/crash-vehicles";
import A from "@rdub/next-base/a";
import { Tooltip } from "@mui/material";

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
    mc: "Municipality",
    casualties: "Casualties",
    road: "Road",
    cross_street: "Cross Street",
    mp: "MP",
    ll: "Lat, Lon",
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
        pedestrians,
        vehicles,
    }: {
        occupants?: Occupant[]
        pedestrians?: Pedestrian[]
        vehicles?: Vehicle[]
    }
) {
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
        const ageSexStr = `${age ?? ''}${sex === 'M' || sex === 'F' ? sex : ''}`
        let title = `${type}${ageSexStr ? `, ${ageSexStr},` : ''} ${txt}${ejectedStr ? `, ${ejectedStr}` : ''}`
        const icon = <Component key={idx} title={title} style={{fill}}/>
        arrs[condition].push(icon)
    })
    pedestrians?.forEach(({ condition, age, sex, inj_loc, inj_type, cyclist, }, idx) => {
        condition = condition ?? 0
        const [ type, Component, ] =
            cyclist
                ? [ 'Cyclist', Cyclist, ]
                : [ 'Pedestrian', Ped, ]
        const { txt, fill } = ConditionMap[condition]
        const ageSexStr = `${age ?? ''}${sex === 'M' || sex === 'F' ? sex : ''}`
        let title = `${type}${ageSexStr ? `, ${ageSexStr},` : ''} ${txt}`
        const icon = <Component key={idx} title={title} style={{ fill }} />
        arrs[condition].push(icon)
    })
    return <div className={css.icons}>
        {deaths.length ? <span className={css.typeIcons}>{deaths}</span> : null}
        {seriousInjuries.length ? <span className={css.typeIcons}>{seriousInjuries}</span> : null}
        {moderateInjuries.length ? <span className={css.typeIcons}>{moderateInjuries}</span> : null}
        {possibleInjuries.length ? <span className={css.typeIcons}>{possibleInjuries}</span> : null}
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
                                return <Car key={i} style={{ fill }} title={title} />
                            }
                        )
                    }
                </span>
                : null
        }
    </div>
}

export function gmapsUrl({ lat, lon, }: { lat: number, lon: number }) {
    return `https://www.google.com/maps/?q=${lat},${lon}`
}

export function getCrashRows({ rows, cols, county, crashOccupants, crashPedestrians, crashVehicles, }: {
    rows: Crash[]
    cols: Col[]
    county?: County
    crashOccupants: CrashesOccupants | null
    crashPedestrians: CrashesPedestrians | null
    crashVehicles: CrashesVehicles | null
}): Row[] {
    return rows.map(row => {
        const { id } = row
        const occupants = crashOccupants?.[id]
        const pedestrians = crashPedestrians?.[id]
        const vehicles = crashVehicles?.[id]
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode = ''
                if (col == 'dt') {
                    txt = strftime('%-m/%-d/%y %-I:%M%p', new Date(row.dt))
                } else if (col == 'll') {
                    const { ilat, ilon, olat, olon } = row
                    const [ lat, lon ] = ilat && ilon ? [ ilat, ilon ] : [ olat, olon ]
                    txt = (lat && lon)
                        ? `${lat?.toFixed(6)}, ${lon?.toFixed(6)}`
                        : ''
                } else if (col == 'road') {
                    const { road, sri } = row
                    txt = <Tooltip arrow title={sri ? `SRI ${sri}` : undefined}><span>{road}</span></Tooltip>
                } else if (col == 'casualties') {
                    txt = <CrashIcons
                        occupants={occupants}
                        pedestrians={pedestrians}
                        vehicles={vehicles}
                    />
                } else if (col == 'mc') {
                    const { mc } = row
                    if (!county) {
                        throw new Error('`mc2mn` is required for `mc` col')
                    }
                    const { cn, mc2mn } = county
                    const mn = mc2mn[mc]
                    const city = normalize(mn)
                    txt = <A href={`/c/${normalize(cn)}/${city}`}>{mn}</A>
                } else if (col == 'mp') {
                    const { mp, ilat, ilon } = row
                    if (mp) {
                        txt = mp.toFixed(2)
                        if (ilat && ilon) {
                            const href = gmapsUrl({ lat: ilat, lon: ilon })
                            txt = <A href={href}>{txt}</A>
                        }
                    }
                } else {
                    txt = row[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}

export function useCrashRows({ county, ...props }: Props & { county?: County }) {
    const crashesResult = useCrashes({ ...props })
    const crashOccupants = useCrashOccupants({ crashesResult, ...props })
    const crashPedestrians = useCrashPedestrians({ crashesResult, ...props })
    const crashVehicles = useCrashVehicles({ crashesResult, ...props })
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'road', 'cross_street', 'mp', ]
    const crashRows = useMemo(
        () => {
            if (!crashesResult) return
            console.log("crashRows effect")
            const crashRows = map(
                (crashes: Crash[]) => getCrashRows({ rows: crashes, cols, county, crashOccupants, crashPedestrians, crashVehicles, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, crashOccupants, ]
    )
    return crashRows
}
