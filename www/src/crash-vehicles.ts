import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { Base } from "@/src/use-crashes";

export type Vehicle = {
    crash_id: number
    damage: number
    damage_loc: number
    impact_loc: number
    departure: number
    type: number
}

export type CrashesVehicles = { [crash_id: number]: Vehicle[] }

export function useCrashVehicles({ crashesResult, urls, ...props }: { crashesResult: Result<Crash> | null } & Base): CrashesVehicles | null {
    const [ crashVehicles, setCrashVehicles ] = useState<CrashesVehicles | null>(null)
    const fetchVehStats = useSqlQueryCallback<Vehicle>({ url: urls.vehicles, ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("vehStats effect")
            map(
                (crashes: Crash[]) => {
                    const crashIds = crashes.map(({ id }) => id)
                    const query = `
                        select
                            crash_id,
                            damage,
                            damage_loc,
                            impact_loc,
                            departure,
                            type
                        from vehicles v
                        where crash_id in (${crashIds.join(', ')})
                    `
                    console.log("Fetching vehStats")
                    fetchVehStats(query)?.then(vehStats => {
                        fold(
                            err => {
                                console.error("error fetching occ stats:", err)
                                return null
                            },
                            (vehicles: Vehicle[]) => {
                                console.log("crashVehicles:", vehicles)
                                const crashVehicles = {} as CrashesVehicles
                                for (const vehStat of vehicles) {
                                    const { crash_id } = vehStat
                                    if (!crashVehicles[crash_id]) {
                                        crashVehicles[crash_id] = []
                                    }
                                    crashVehicles[crash_id].push(vehStat)
                                }
                                setCrashVehicles(crashVehicles )
                            }
                        )(vehStats)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchVehStats ]
    )
    return crashVehicles
}
