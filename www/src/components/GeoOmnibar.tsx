import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { useAction, useOmnibarEndpoint } from "use-kbd"
import type { EndpointPagination, EndpointResponse, OmnibarEntry } from "use-kbd"
import { useGeoFilter } from "@/src/GeoFilterContext"
import { normalize } from "@/src/county"

/**
 * Registers:
 * 1. Omnibar endpoint for searching counties/municipalities (Cmd+K)
 * 2. Navigation actions for statewide view
 */
export function useGeoActions() {
    const { cc2mc2mn } = useGeoFilter()
    const navigate = useNavigate()

    // Omnibar endpoint: searchable list of counties + municipalities
    const allEntries = useMemo((): OmnibarEntry[] => {
        if (!cc2mc2mn) return []
        const entries: OmnibarEntry[] = [
            { id: 'nav:nj', label: 'New Jersey (statewide)', href: '/', group: 'Navigation' },
        ]
        for (const [, { cn, mc2mn }] of Object.entries(cc2mc2mn)) {
            entries.push({
                id: `county:${normalize(cn)}`,
                label: `${cn} County`,
                href: `/c/${normalize(cn)}`,
                group: 'Counties',
            })
            for (const [, mn] of Object.entries(mc2mn)) {
                entries.push({
                    id: `muni:${normalize(cn)}:${normalize(mn)}`,
                    label: mn,
                    description: `${cn} County`,
                    href: `/c/${normalize(cn)}/${normalize(mn)}`,
                    group: 'Municipalities',
                    keywords: [cn],
                })
            }
        }
        return entries
    }, [cc2mc2mn])

    const filter = useMemo(() => {
        return (query: string, { offset, limit }: EndpointPagination): EndpointResponse => {
            const q = query.toLowerCase()
            const matches = allEntries.filter(e =>
                e.label.toLowerCase().includes(q) ||
                (e.description?.toLowerCase().includes(q)) ||
                (e.keywords?.some(k => k.toLowerCase().includes(q)))
            )
            return {
                entries: matches.slice(offset, offset + limit),
                total: matches.length,
            }
        }
    }, [allEntries])

    useOmnibarEndpoint('geo', {
        filter,
        group: 'Places',
        minQueryLength: 1,
        pageSize: 20,
    })

    // Top-level actions (shown in shortcuts modal, have keybindings)
    useAction('nav:home', {
        label: 'Go to statewide view',
        group: 'Navigation',
        defaultBindings: ['g h'],
        handler: () => navigate('/'),
    })
}
