import { Result } from "@/src/api"
import { apiUrl, useApi } from "@/src/api"
import { Crash } from "@/src/crash"
import { useMemo } from "react"
import { fold } from "fp-ts/Either"

export type Vehicle = {
    crash_id: number
    damage: number
    damage_loc: number
    impact_loc: number
    departure: number
    type: number
}

export type CrashesVehicles = { [crash_id: number]: Vehicle[] }

export function useCrashVehicles({ crashesResult }: { crashesResult: Result<Crash> | null }): CrashesVehicles | null {
    const crashIds = useMemo(() => {
        if (!crashesResult) return null
        return fold(
            () => null as number[] | null,
            (crashes: Crash[]) => crashes.map(({ id }) => id),
        )(crashesResult)
    }, [crashesResult])

    const url = useMemo(
        () => crashIds?.length ? apiUrl("/njdot/vehicles", { crash_ids: crashIds.join(",") }) : null,
        [crashIds],
    )
    const result = useApi<Vehicle>(url)

    return useMemo(() => {
        if (!result) return null
        return fold(
            () => null as CrashesVehicles | null,
            (vehicles: Vehicle[]) => {
                const grouped: CrashesVehicles = {}
                for (const vehicle of vehicles) {
                    const { crash_id } = vehicle
                    if (!grouped[crash_id]) grouped[crash_id] = []
                    grouped[crash_id].push(vehicle)
                }
                return grouped
            },
        )(result)
    }, [result])
}
