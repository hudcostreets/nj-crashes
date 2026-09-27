import { useQuery, useQueryClient } from "@tanstack/react-query"
import { fetchEntity, fetchEntityBySlug, isRoadSlug, type RoadEntity } from "./roadsData"

/** A road reference from a URL: a slug (`hudson/jersey-city/west-side-avenue`), or a numeric
 *  entity id (accepted for old links; ids aren't stable across builds, so callers rewrite it to
 *  the slug). Null when it's neither. */
export function parseRoadRef(s: string | null | undefined): string | number | null {
    if (!s) return null
    const t = s.replace(/^\/+|\/+$/g, "")
    if (/^\d+$/.test(t)) return Number(t)
    return isRoadSlug(t) ? t : null
}

/** A road entity by slug or id, cached under both keys (`["road-slug", slug]`,
 *  `["road-entity", id]`), so moving between the two forms doesn't refetch. */
export function useRoadEntity(ref: string | number | null) {
    const queryClient = useQueryClient()
    return useQuery({
        queryKey: typeof ref === "number" ? ["road-entity", ref] : ["road-slug", ref],
        queryFn: async (): Promise<RoadEntity | null> => {
            const e = typeof ref === "number" ? await fetchEntity(ref) : await fetchEntityBySlug(ref!)
            if (e) {
                queryClient.setQueryData(["road-entity", e.entity], e)
                queryClient.setQueryData(["road-slug", e.slug], e)
            }
            return e
        },
        enabled: ref !== null,
    })
}
