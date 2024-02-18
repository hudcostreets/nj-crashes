import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { fromEntries } from "@rdub/base/objs";
import { Base } from "@/src/use-crashes";

export type CrashOccStats = {
    crash_id: number
    dk: number  // drivers killed
    di: number  // drivers injured
    ok: number  // passengers (occupants) killed
    oi: number  // passengers (occupants) injured
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
