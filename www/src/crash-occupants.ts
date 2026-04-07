import { Result } from "@/src/api"
import { apiUrl, useApi } from "@/src/api"
import { Crash } from "@/src/crash"
import { useEffect, useMemo, useState } from "react"
import { fold } from "fp-ts/Either"

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

export function useCrashOccupants({ crashesResult }: { crashesResult: Result<Crash> | null }): CrashesOccupants | null {
    const crashIds = useMemo(() => {
        if (!crashesResult) return null
        return fold(
            () => null as number[] | null,
            (crashes: Crash[]) => crashes.map(({ id }) => id),
        )(crashesResult)
    }, [crashesResult])

    const url = useMemo(
        () => crashIds?.length ? apiUrl("/njdot/occupants", { crash_ids: crashIds.join(",") }) : null,
        [crashIds],
    )
    const result = useApi<Occupant>(url)

    return useMemo(() => {
        if (!result) return null
        return fold(
            () => null as CrashesOccupants | null,
            (occupants: Occupant[]) => {
                const grouped: CrashesOccupants = {}
                for (const occupant of occupants) {
                    const { crash_id } = occupant
                    if (!grouped[crash_id]) grouped[crash_id] = []
                    grouped[crash_id].push(occupant)
                }
                return grouped
            },
        )(result)
    }, [result])
}
