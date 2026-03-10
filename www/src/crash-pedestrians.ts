import { Result } from "@/src/api"
import { apiUrl, useApi } from "@/src/api"
import { Crash } from "@/src/crash"
import { useMemo } from "react"
import { fold } from "fp-ts/Either"

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

export function useCrashPedestrians({ crashesResult }: { crashesResult: Result<Crash> | null }): CrashesPedestrians | null {
    const crashIds = useMemo(() => {
        if (!crashesResult) return null
        return fold(
            () => null as number[] | null,
            (crashes: Crash[]) => crashes.map(({ id }) => id),
        )(crashesResult)
    }, [crashesResult])

    const url = useMemo(
        () => crashIds?.length ? apiUrl("/njdot/pedestrians", { crash_ids: crashIds.join(",") }) : null,
        [crashIds],
    )
    const result = useApi<Pedestrian>(url)

    return useMemo(() => {
        if (!result) return null
        return fold(
            () => null as CrashesPedestrians | null,
            (pedestrians: Pedestrian[]) => {
                const grouped: CrashesPedestrians = {}
                for (const ped of pedestrians) {
                    const { crash_id } = ped
                    if (!grouped[crash_id]) grouped[crash_id] = []
                    grouped[crash_id].push(ped)
                }
                return grouped
            },
        )(result)
    }, [result])
}
