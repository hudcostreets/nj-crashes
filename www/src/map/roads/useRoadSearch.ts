import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useOmnibarEndpoint } from "use-kbd"
import type { OmnibarEntry } from "use-kbd"
import { useDb } from "@/src/lib/DuckDbContext"
import { loadCC2MC2MN } from "@/src/lib/data"
import { fetchEntity, type Bbox } from "./roadsData"
import { formatRoadHit, searchRoads } from "./roadSearch"

const LIMIT = 20

/** Omnibar (⌘K) road search: picking a result selects the road (`?road=<entity>`) and zooms to it. */
export function useRoadSearch({ setRoad, zoomTo }: { setRoad: (entity: number) => void; zoomTo: (bbox: Bbox) => void }) {
    const db = useDb()
    const queryClient = useQueryClient()
    const { data: cc2mc2mn = null } = useQuery({ queryKey: ["cc2mc2mn"], queryFn: loadCC2MC2MN, staleTime: Infinity })

    const select = async (entity: number) => {
        setRoad(entity)
        if (!db) return
        // Same key as `useRoadSelection`'s entity query, which the selection then reuses.
        const info = await queryClient.fetchQuery({ queryKey: ["road-entity", entity], queryFn: () => fetchEntity(db, entity) })
        if (info) zoomTo([info.lon_min, info.lat_min, info.lon_max, info.lat_max])
    }

    useOmnibarEndpoint("roads", {
        group: "Roads",
        minQueryLength: 2,
        pageSize: LIMIT,
        fetch: async (query, signal) => {
            if (!db) return { entries: [] }
            const hits = await searchRoads(db, query, LIMIT)
            if (signal.aborted) return { entries: [] }
            const entries: OmnibarEntry[] = hits.map(hit => {
                const { label, description } = formatRoadHit(hit, query, cc2mc2mn)
                return {
                    id: `road:${hit.entity}`,
                    label,
                    description,
                    handler: () => { void select(hit.entity) },
                }
            })
            return { entries }
        },
    })
}
