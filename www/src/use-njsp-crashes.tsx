import { Result } from "@rdub/react-sql.js-httpvfs/query";
import { ReactNode, useMemo } from "react";
import { useSqlQuery } from "@/src/sql";
import { County, MC2MN, normalize } from "@/src/county";
import { map } from "fp-ts/Either";
import { Base, ConditionMap, } from "./use-njdot-crashes";
import * as Crashes from "./use-njdot-crashes"
import { Row } from "@/src/result-table";
import { fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import strftime from "strftime";
import A from "@rdub/next-base/a";
import css from "@/src/use-crashes.module.scss";
import { Cyclist, Driver, Passenger, Pedestrian, Person } from "@/src/icons";

export type Props = Base & {
    cc: number
    mc?: number
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
    dt: "Date/Time",
    mc: "Municipality",
    casualties: "Casualties",
    location: "Location",
    street: "Street",
    highway: "Highway",
}
export type Col = keyof typeof ColLabels

export type Total = { total: number }

export function useNjspCrashesTotal({ cc, mc, timerId = "njsp-crashes-total", urls, ...base }: Props): Result<Total> | null {
    const query = useMemo(
        () => {
            return `
                select count(*) as total from crashes
                where cc=${cc}${mc ? ` and mc=${mc}` : ""}
            `
        },
        [ cc, mc, ]
    )
    return useSqlQuery<Total>({ ...base, url: urls.njsp.crashes, timerId, query })
}
export function useNjspCrashes({ cc, mc, page, perPage, timerId = "njsp-crashes", urls, ...base }: Crashes.Props): Result<Crash> | null {
    const query = useMemo(
        () => {
            const offset = page * perPage
            return `
                select * from crashes
                where cc=${cc}${mc ? ` and mc=${mc}` : ""}
                order by dt desc
                limit ${perPage} offset ${offset}
            `
        },
        [ page, perPage ]
    )
    return useSqlQuery<Crash>({ ...base, url: urls.njsp.crashes, timerId, query })
}

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

export function getCrashRows({ rows, cols, county, }: {
    rows: Crash[]
    cols: Col[]
    county?: County
}): Row[] {
    return rows.map(row => {
        const { id } = row
        return fromEntries([
            [ 'key', id ],
            ...cols.map(col => {
                let txt: ReactNode = ''
                if (col == 'dt') {
                    txt = strftime('%-m/%-d/%y %-I:%M%p', new Date(row.dt))
                } else if (col == 'casualties') {
                    txt = <CrashIcons {...row} />
                } else if (col == 'mc') {
                    const { mc } = row
                    if (!county) {
                        throw new Error('`mc2mn` is required for `mc` col')
                    }
                    const { cn, mc2mn } = county
                    const mn = mc2mn[mc]
                    const city = normalize(mn)
                    txt = <A href={`/c/${normalize(cn)}/${city}`}>{mn}</A>
                } else {
                    txt = row[col] ?? ''
                }
                return [ ColLabels[col], txt ] as [ string, string | number ]
            })
        ]) as Row
    })
}

export function useNjspCrashRows({ mc2mn, ...props }: Crashes.Props & { mc2mn?: MC2MN }) {
    const crashesResult = useNjspCrashes({ ...props })
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...mcCol, 'casualties', 'location', ]  // 'street', 'highway', ]
    const crashRows = useMemo(
        () => {
            if (!crashesResult) return
            console.log("useNjspCrashRows effect")
            const county = mc2mn ? { cn: props.cn, mc2mn } : undefined
            const crashRows = map(
                (crashes: Crash[]) => getCrashRows({ rows: crashes, cols, county, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, ]
    )
    return crashRows
}

