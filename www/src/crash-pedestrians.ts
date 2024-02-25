import { Result, useSqlQueryCallback } from "@rdub/react-sql.js-httpvfs/query";
import { Crash } from "@/src/crash";
import { useEffect, useState } from "react";
import { fold, map } from "fp-ts/Either";
import { Base } from "@/src/use-njdot-crashes";

export type Pedestrian = {
    crash_id: number
    pos: number
    condition: number
    age: number
    sex: string
    inj_loc: number
    inj_type: number
    cyclist: boolean
}

export type CrashesPedestrians = { [crash_id: number]: Pedestrian[] }

export function useCrashPedestrians({ crashesResult, urls, ...props }: { crashesResult: Result<Crash> | null } & Base): CrashesPedestrians | null {
    const [ crashPedestrians, setCrashPedestrians ] = useState<CrashesPedestrians | null>(null)
    const fetchPedestrians = useSqlQueryCallback<Pedestrian>({ url: urls.dot.pedestrians, timerId: "pedestrians", ...props })
    useEffect(
        () => {
            if (!crashesResult) return
            console.log("pedestrian effect")
            map(
                (crashes: Crash[]) => {
                    const crashIds = crashes.map(({ id }) => id)
                    const query = `
                        select crash_id, condition, age, sex, inj_loc, inj_type, cyclist
                        from pedestrians
                        where crash_id in (${crashIds.join(', ')}) and condition >= 1 and condition < 5
                        order by crash_id, condition, cyclist
                    `
                    console.log("Fetching pedestrians")
                    fetchPedestrians(query)?.then(pedestriansResult => {
                        fold(
                            err => {
                                console.error("error fetching pedestrians:", err)
                                return null
                            },
                            (pedestrians: Pedestrian[]) => {
                                console.log("crashPedestrians:", pedestrians)
                                const crashPedestrians = {} as CrashesPedestrians
                                for (const pedestrian of pedestrians) {
                                    const { crash_id } = pedestrian
                                    if (!crashPedestrians[crash_id]) {
                                        crashPedestrians[crash_id] = []
                                    }
                                    crashPedestrians[crash_id].push(pedestrian)
                                }
                                setCrashPedestrians(crashPedestrians )
                            }
                        )(pedestriansResult)
                    })
                }
            )(crashesResult)
        },
        [ crashesResult, fetchPedestrians ]
    )
    return crashPedestrians
}
