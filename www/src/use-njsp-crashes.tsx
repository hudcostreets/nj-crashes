import { Result } from "@rdub/react-sql.js-httpvfs/query";
import { ReactNode, useMemo } from "react";
import { useSqlQuery, useSqlQueryEager } from "@/src/sql";
import { CC2MC2MN, County } from "@/src/county";
import { map } from "fp-ts/Either";
import { Base, ConditionMap, } from "./use-njdot-crashes";
import { Row } from "@/src/result-table";
import { fromEntries } from "@rdub/base/objs";
import { range } from "@rdub/base/arr";
import strftime from "strftime";
import css from "@/src/use-crashes.module.scss";
import { Cyclist, Driver, Passenger, Pedestrian, Person } from "@/src/icons";
import { Tooltip } from "@/src/tooltip";
import CityLink from "@/src/city-link";
import CountyLink from "@/src/county-link";
import { curYear } from "@/src/constants";

export type Props = Base & {
    cc: number | null
    cn?: string
    mc: number | null
    page: number
    perPage: number
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
    cc: "County",
    mc: "Municipality",
    casualties: "Casualties",
    location: "Location",
    street: "Street",
    highway: "Highway",
}
export type Col = keyof typeof ColLabels

export type Total = { total: number }

export function totalsQuery({ cc, mc, }: { cc: number | null, mc: number | null }) {
    const where = cc ? `where cc=${cc}${mc ? ` and mc=${mc}` : ""}` : ""
    return `
        select count(*) as total from crashes
        ${where}
    `}

export function crashesQuery({ cc, mc, page, perPage, }: { cc: number | null, mc: number | null, page: number, perPage: number }) {
    const where = cc ? `where cc=${cc}${mc ? ` and mc=${mc}` : ""}` : ""
    const offset = page * perPage
    return `
        select * from crashes
        ${where}
        order by dt desc
        limit ${perPage} offset ${offset}
    `}

export function useNjspCrashesTotal(
    {
        cc, mc,
        timerId = "njsp-crashes-total",
        urls,
        totals,
        ...base
    }: Omit<Props, 'cn' | 'page' | 'perPage'> & { totals: Total[] }
): Result<Total> {
    const query = useMemo(() => totalsQuery({ cc, mc, }), [ cc, mc, ])
    return useSqlQueryEager<Total>({ ...base, url: urls.njsp.crashes, timerId, query, init: totals, })
}
export function useNjspCrashes({ cc, mc, page, perPage, timerId = "njsp-crashes", urls, crashes, ...base }: Props & { crashes: Crash[] }): Result<Crash> {
    const query = useMemo(
        () => {
            return crashesQuery({ cc, mc, page, perPage })
        },
        [ cc, mc, page, perPage ]
    )
    return useSqlQueryEager<Crash>({ ...base, url: urls.njsp.crashes, timerId, query, init: crashes, })
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
                if (col == 'dt') {
                    const date = new Date(row.dt)
                    const fmt = date.getFullYear() == curYear ? '%a %b %-d %-I:%M%p' : `%-m/%-d/%y, %-I:%M%p`
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

export function useNjspCrashRows({ cc2mc2mn, ...props }: Props & { cc2mc2mn: CC2MC2MN, crashes: Crash[], }) {
    const crashesResult = useNjspCrashes({ ...props })
    const ccCol: Col[] = props.cc ? [] : ['cc']
    const mcCol: Col[] = props.mc ? [] : ['mc']
    const cols: Col[] = [ 'dt', ...ccCol, ...mcCol, 'casualties', 'location', ]  // 'street', 'highway', ]
    const crashRows = useMemo(
        () => {
            // console.log("useNjspCrashRows effect")
            const crashRows = map(
                (crashes: Crash[]) => getNjspCrashRows({ rows: crashes, cols, cc2mc2mn, })
            )(crashesResult)
            return crashRows
        },
        [ crashesResult, cols, ]
    )
    return crashRows
}

