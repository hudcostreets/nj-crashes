import { ReactNode } from "react";
import { CC2MC2MN } from "@/src/county";
import { ConditionMap, } from "./use-njdot-crashes";
import { Row } from "@/src/result-table";
import { fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import strftime from "strftime";
import css from "@/src/use-crashes.module.scss";
import { Cyclist, Driver, Passenger, Pedestrian, Person } from "@/src/icons";
import { Tooltip } from "@/src/tooltip";
import CityLink from "@/src/city-link";
import CountyLink from "@/src/county-link";
import { curYear } from "@/src/plotSpecs";
import { Crash } from "./njsp/crash";
import { CCMC } from "@/src/njsp/region";

export type Props = CCMC & {
    crashes: Crash[]
}

export const ColLabels = {
    id: "ID",
    dt: "Date/Time",
    cc: "County",
    mc: "Municipality",
    casualties: "Casualties",
    location: "Location",
    street: "Street",
    highway: "Highway",
}
export type Col = keyof typeof ColLabels

export function CrashIcons({ tk, dk, ok, pk, bk, ti, }: Crash) {
    const injuryFill = ConditionMap[0].fill
    const uk = tk - dk - ok - pk - bk
    return (
        <div className={css.icons}>
            <span className={css.typeIcons}>
                {range(dk).map(idx => <Driver key={idx} title={"Driver killed"} />)}
                {range(ok).map(idx => <Passenger key={idx} title={"Passenger killed"} />)}
                {range(pk).map(idx => <Pedestrian key={idx} title={"Pedestrian killed"} />)}
                {range(bk).map(idx => <Cyclist key={idx} title={"Cyclist killed"} />)}
                {range(uk).map(idx => <Person key={idx} title={"Person killed"} />)}
                {range(ti).map(idx => <Person key={idx} title={"Person injured"} style={{ fill: injuryFill }} />)}
            </span>
        </div>
    )
}

export function getNjspCrashRows({ crashes, cc2mc2mn, cc, mc, }: Props & { cc2mc2mn: CC2MC2MN }): Row[] {
    const ccCol: Col[] = cc ? [] : ['cc']
    const mcCol: Col[] = mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...ccCol, ...mcCol, 'casualties', 'location', ]  // 'street', 'highway', ]
    return crashes.map(crash => {
        const { id } = crash
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode
                if (col == 'dt') {
                    const date = new Date(crash.dt)
                    const fmt = date.getFullYear() == curYear ? '%a %b %-d %-I:%M%p' : `%-m/%-d/%y, %-I:%M%p`
                    txt = <Tooltip title={`NJSP ACCID: ${id}`}>
                        <span>{strftime(fmt, date)}</span>
                    </Tooltip>
                } else if (col == 'casualties') {
                    txt = <CrashIcons {...crash} />
                } else if (col == 'cc') {
                    txt = <CountyLink cc={crash.cc} cc2mc2mn={cc2mc2mn} />
                } else if (col == 'mc') {
                    txt = <CityLink {...crash} cc2mc2mn={cc2mc2mn} />
                } else {
                    txt = crash[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}
