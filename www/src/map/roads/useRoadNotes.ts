import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { scopeNotes, type NoteTarget, type ScopeNote } from "./roadNotes"
import { fetchRoadNotes, type RoadEntity } from "./roadsData"
import type { RoadScope } from "./useRoadScope"

/** The data notes for a road scope: the corridor's (and its members') in corridor scope, else the
 *  road's (a span shows its road's). Empty while loading, and when the build has no `road-notes`
 *  (the read fails once, unretried). */
export function useRoadNotes(info: RoadEntity | null, scope: Pick<RoadScope, "state" | "corridor">): ScopeNote[] {
    const target = useMemo((): NoteTarget | null => {
        if (scope.state.corridor && scope.corridor) {
            const members = scope.corridor.entities.split(",").map(Number).filter(Number.isInteger)
            return { corridor: scope.corridor.corridor, members }
        }
        return info ? { entity: info.entity } : null
    }, [scope.state.corridor, scope.corridor, info])
    const q = useQuery({
        queryKey: ["road-notes", target],
        queryFn: () => fetchRoadNotes(target!),
        enabled: target !== null,
        staleTime: Infinity,
        retry: false,
    })
    return useMemo(() => (target && q.data ? scopeNotes(q.data, target) : []), [target, q.data])
}
