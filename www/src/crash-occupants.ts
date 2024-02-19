import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { Base } from "@/src/use-crashes";

export type Occupant = {
    crash_id: number
    pos: number
    condition: number
    eject: number
    age: number
    sex: string
    inj_loc: number
    inj_type: number
}

export type CrashesOccupants = { [crash_id: number]: Occupant[] }

export function useCrashOccupants({ crashesResult, urls, ...props }: { crashesResult: Result<Crash> | null } & Base): CrashesOccupants | null {
    const [ crashOccupants, setCrashOccupants ] = useState<CrashesOccupants | null>(null)
    const fetchOccpants = useSqlQueryCallback<Occupant>({ url: urls.occupants, ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("occupants effect")
            map(
                (crashes: Crash[]) => {
                    const crashIds = crashes.map(({ id }) => id)
                    const query = `
                        select crash_id, pos, condition, eject, age, sex, inj_loc, inj_type
                        from occupants
                        where crash_id in (${crashIds.join(', ')}) and condition >= 1 and condition < 5
                        order by crash_id, condition, pos
                    `
                    console.log("Fetching occupants")
                    fetchOccpants(query)?.then(occupantsResult => {
                        fold(
                            err => {
                                console.error("error fetching occupants:", err)
                                return null
                            },
                            (occupants: Occupant[]) => {
                                console.log("crashOccupants:", occupants)
                                const crashOccupants = {} as CrashesOccupants
                                for (const occupant of occupants) {
                                    const { crash_id } = occupant
                                    if (!crashOccupants[crash_id]) {
                                        crashOccupants[crash_id] = []
                                    }
                                    crashOccupants[crash_id].push(occupant)
                                }
                                setCrashOccupants(crashOccupants )
                            }
                        )(occupantsResult)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchOccpants ]
    )
    return crashOccupants
}
