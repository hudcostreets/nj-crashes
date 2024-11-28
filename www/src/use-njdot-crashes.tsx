import { ReactNode } from "react";
import { Crash, Occupant, Pedestrian, Vehicle } from "@/src/njdot/crash";
import { Row } from "@/src/result-table";
import { CC2MC2MN, County } from "@/src/county";
import strftime from "strftime";
import { fromEntries } from "@rdub/base/objs";
import { Car, Cyclist, Driver, Passenger, Pedestrian as Ped } from "@/src/icons";
import css from "./use-crashes.module.scss"
import A from "@rdub/next-base/a";
import { Tooltip } from "@/src/tooltip"
import CityLink from "@/src/city-link";
import CountyLink from "@/src/county-link";
import { CCMC } from "@/src/njsp/region";

export type Props = CCMC & {
    crashes: Crash[]
    cc2mc2mn: CC2MC2MN
}

export const ColLabels = {
    id: "ID",
    dt: "Date/Time",
    cc: "County",
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

export const ConditionMap = [
    { txt: "condition unknown", fill: unknown, },
    { txt: "deceased", fill: 'black', },
    { txt: "serious injury", fill: red, },
    { txt: "moderate injury", fill: "orange", },
    { txt: "possible injury", fill: "#8B8000", },
]

export function CrashIcons(
    {
        occs,
        peds,
        vehs,
    }: {
        occs?: Occupant[]
        peds?: Pedestrian[]
        vehs?: Vehicle[]
    }
) {
    const deaths = [] as ReactNode[]
    const seriousInjuries = [] as ReactNode[]
    const moderateInjuries = [] as ReactNode[]
    const possibleInjuries = [] as ReactNode[]
    const arrs = [ [], deaths, seriousInjuries, moderateInjuries, possibleInjuries, ]
    occs?.forEach(({ pos, condition, eject, age, sex, inj_loc, inj_type, }, idx) => {
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
    peds?.forEach(({ condition, age, sex, inj_loc, inj_type, cyclist, }, idx) => {
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
            vehs?.length
                ? <span className={css.typeIcons}>
                    {/*<span className={css.typeIcon}>🚗</span>*/}
                    {
                        vehs.map(
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

export function getNjdotCrashRows({ crashes, cc, mc, cc2mc2mn, }: Props): Row[] {
    const ccCol: Col[] = cc ? [] : ['cc']
    const mcCol: Col[] = mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...ccCol, ...mcCol, 'casualties', 'road', 'cross_street', 'mp', ]
    return crashes.map(({ crash, occs, peds, vehs }) => {
        const { id } = crash
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode = ''
                if (col == 'dt') {
                    txt = <Tooltip title={`Crash ID: ${id}`}>
                        <span>{
                            strftime('%-m/%-d/%y %-I:%M%p', new Date(crash.dt))
                        }</span>
                    </Tooltip>
                } else if (col == 'll') {
                    const { ilat, ilon, olat, olon } = crash
                    const [ lat, lon ] = ilat && ilon ? [ ilat, ilon ] : [ olat, olon ]
                    txt = (lat && lon)
                        ? `${lat?.toFixed(6)}, ${lon?.toFixed(6)}`
                        : ''
                } else if (col == 'road') {
                    const { road, sri } = crash
                    txt = <Tooltip title={sri ? `SRI ${sri}` : undefined}><span>{road}</span></Tooltip>
                } else if (col == 'casualties') {
                    txt = <CrashIcons
                        occs={occs}
                        peds={peds}
                        vehs={vehs}
                    />
                } else if (col == 'cc') {
                    txt = <CountyLink cc={crash.cc} cc2mc2mn={cc2mc2mn} />
                } else if (col == 'mc') {
                    txt = <CityLink {...crash} cc2mc2mn={cc2mc2mn} />
                } else if (col == 'mp') {
                    const { mp, ilat, ilon } = crash
                    if (mp) {
                        txt = mp.toFixed(2)
                        if (ilat && ilon) {
                            const href = gmapsUrl({ lat: ilat, lon: ilon })
                            txt = <A href={href}>{txt}</A>
                        }
                    }
                } else {
                    txt = crash[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}
