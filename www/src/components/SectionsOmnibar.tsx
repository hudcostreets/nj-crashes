import { useMemo } from "react"
import { useOmnibarEndpoint } from "use-kbd"
import type { EndpointPagination, EndpointResponse, OmnibarEntry } from "use-kbd"

/**
 * Registers an omnibar endpoint that finds in-page sections by their
 * `<h2 id="…">` headings and scrolls to the matching anchor on select.
 *
 * Entries are queried from the live DOM on each filter call so dynamically-
 * rendered sections (e.g. plots gated behind data load) appear once they
 * mount. No memoization on the entry list is needed — building it is a
 * sub-millisecond DOM walk.
 */
export function useSectionsActions() {
    const filter = useMemo(() => {
        return (query: string, { offset, limit }: EndpointPagination): EndpointResponse => {
            const headers = Array.from(document.querySelectorAll<HTMLElement>("h2[id]"))
            const q = query.toLowerCase()
            const entries: OmnibarEntry[] = []
            for (const h of headers) {
                const label = (h.textContent ?? "").trim()
                if (!label) continue
                if (q && !label.toLowerCase().includes(q)) continue
                const id = h.id
                entries.push({
                    id: `section:${id}`,
                    label,
                    description: "Section",
                    group: "Sections",
                    handler: () => {
                        const el = document.getElementById(id)
                        if (!el) return
                        el.scrollIntoView({ behavior: "smooth", block: "start" })
                        // Update URL hash so refreshes/share-links land here.
                        history.replaceState(null, "", `#${id}`)
                    },
                })
            }
            return {
                entries: entries.slice(offset, offset + limit),
                total: entries.length,
            }
        }
    }, [])

    useOmnibarEndpoint("sections", {
        filter,
        group: "On this page",
        minQueryLength: 0,
        pageSize: 20,
    })
}
