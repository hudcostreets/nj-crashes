import { useOmnibarEndpoint } from "use-kbd"
import type { OmnibarEntry } from "use-kbd"
import type { Bbox } from "./roadsData"
import { formatRoadHit, hitBbox, searchRoads } from "./roadSearch"

const LIMIT = 20

/** Omnibar (⌘K) road search: picking a result selects the road (`?road=<slug>`) and zooms to the
 *  matched name's span. Results come back most-crashes first, but use-kbd re-ranks endpoint entries
 *  by its fuzzy score (`~/c/js/use-kbd/specs/endpoint-preserve-order.md`); the matched alias goes in
 *  `keywords` so alias-only matches still score. */
export function useRoadSearch({ setRoad, zoomTo }: { setRoad: (slug: string) => void; zoomTo: (bbox: Bbox) => void }) {
    useOmnibarEndpoint("roads", {
        group: "Roads",
        minQueryLength: 2,
        pageSize: LIMIT,
        fetch: async (query, signal) => {
            const hits = await searchRoads(query, LIMIT)
            if (signal.aborted) return { entries: [] }
            const entries: OmnibarEntry[] = hits.map(hit => {
                const { label, description } = formatRoadHit(hit)
                return {
                    id: `road:${hit.slug}`,
                    label,
                    description,
                    keywords: hit.matched ? [hit.matched] : undefined,
                    handler: () => {
                        setRoad(hit.slug)
                        zoomTo(hitBbox(hit))
                    },
                }
            })
            return { entries }
        },
    })
}
