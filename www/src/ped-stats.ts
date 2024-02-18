import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { fromEntries } from "@rdub/base/objs";
import { Base } from "@/src/use-crashes";

export type CrashPedStats = {
    crash_id: number
    pk: number  // pedestrians killed
    pi: number  // pedestrians injured
    bk: number  // bicyclists killed
    bi: number  // bicyclists injured
}

export type CrashesPedStats = { [crash_id: number]: CrashPedStats }

export function usePedestrianStats({ crashesResult, urls, ...props }: { crashesResult: Result<Crash> | null } & Base): CrashesPedStats | null {
    const [ pedStats, setPedStats ] = useState<CrashesPedStats | null>(null)
    const fetchPedStats = useSqlQueryCallback<CrashPedStats>({ url: urls.pedestrians, ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("pedStats effect")
            map(
                (crashes: Crash[]) => {
                    const crashIds = crashes.map(({ id }) => id)
                    const query = `
                        select
                            crash_id,
                            sum(case when p.condition=1 and not p.cyclist then 1 else 0 end) as pk,
                            sum(case when p.condition>1 and not p.cyclist then 1 else 0 end) as pi,
                            sum(case when p.condition=1 and p.cyclist then 1 else 0 end) as bk,
                            sum(case when p.condition>1 and p.cyclist then 1 else 0 end) as bi
                        from pedestrians p
                        where crash_id in (${crashIds.join(', ')})
                        group by crash_id
                    `
                    console.log("Fetching pedStats")
                    fetchPedStats(query)?.then(pedStats => {
                        fold(
                            err => {
                                console.error("error fetching occ stats:", err)
                                return null
                            },
                            (pedStats: CrashPedStats[]) => {
                                console.log("pedStats:", pedStats)
                                setPedStats(fromEntries(pedStats.map(occStat => [ occStat.crash_id, occStat ])))
                            }
                        )(pedStats)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchPedStats ]
    )
    return pedStats
}
