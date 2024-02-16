import { Base } from "@rdub/react-sql.js-httpvfs/query";
import { useMemo } from "react";
import { useSqlQuery } from "@/src/sql";
import { Either, map } from "fp-ts/Either";
import { Totals } from "@/src/crash";
import { Row } from "@/src/result-table";
import { mapEntries } from "@rdub/base/objs";

export type YearStats = {
    y: number
    tk: number
    ti: number
    tv: number
    fc: number
    ic: number
    pc: number
}

const YearStatsColLabels = {
    y: "Year",
    tk: "Fatalities",
    fc: "Fatal Crashes",
    ti: "Injuries",
    ic: "Injury Crashes",
    tv: "Vehicles",
    pc: "Property Damage Crashes",
}

export function yearStatsRows({ years, totals }: { years: YearStats[], totals?: Either<Error, Totals> }): Row[] {
    const rows: Row[] = years.map(row => {
        const { y } = row
        return {
            key: y,
            ...mapEntries(
                row,
                (col, val) => [
                    YearStatsColLabels[col],
                    col === 'y' ? val : val.toLocaleString(),
                ]
            ),
        }
    })
    if (totals) {
        map(
            (totals: Totals) => {
                rows.push({
                    key: '2001–2021',
                    ...mapEntries(
                        years[0],
                        col => [
                            YearStatsColLabels[col],
                            col === 'y' ? '2001–2021' : totals[col].toLocaleString(),
                        ]
                    ),
                })
            }
        )(totals)
    }
    return rows
}

export type Props = Base & {
    cc: number
    mc?: number
}

export function useYearStats({ cc, mc, timerId = 'year-stats', ...base }: Props) {
    const query = useMemo(
        () => {
            const sums = [ 'tk', 'fc', 'ti', 'ic', 'tv', 'pc' ].map(c => `sum(${c}) as ${c}`).join(', ')
            const groupBy = `group by cc${mc ? `, mc` : ``}, y`
            const having = `having cc=${cc}${mc ? ` and mc=${mc}` : ""}`
            return `
                select y, ${sums}
                from cmym ${groupBy}
                ${having}
                order by y desc
            `
        },
        [ cc, mc ]
    )
    return useSqlQuery<YearStats>({ query, timerId, ...base })
}
