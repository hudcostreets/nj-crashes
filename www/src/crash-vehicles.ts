import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { Base } from "@/src/use-njdot-crashes";

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
    const fetchVehicles = useSqlQueryCallback<Vehicle>({ url: urls.dot.vehicles, timerId: "vehicles", ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("vehicles effect")
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
                    console.log("Fetching vehicles")
                    fetchVehicles(query)?.then(vehiclesResult => {
                        fold(
                            err => {
                                console.error("error fetching vehicles:", err)
                                return null
                            },
                            (vehicles: Vehicle[]) => {
                                console.log("crashVehicles:", vehicles)
                                const crashVehicles = {} as CrashesVehicles
                                for (const vehicle of vehicles) {
                                    const { crash_id } = vehicle
                                    if (!crashVehicles[crash_id]) {
                                        crashVehicles[crash_id] = []
                                    }
                                    crashVehicles[crash_id].push(vehicle)
                                }
                                setCrashVehicles(crashVehicles)
                            }
                        )(vehiclesResult)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchVehicles ]
    )
    return crashVehicles
}
