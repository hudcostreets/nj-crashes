import type { ReactNode } from "react"
import { NjspSectionProvider } from "./NjspSectionContext"
import { NjspSectionFilters } from "./NjspSectionFilters"

/** Top-level wrapper for the NJSP plots + Recent-Fatal-Crashes table on the
 *  home page. Owns shared filter state (year range; victim type to follow)
 *  and surfaces a compact filter bar above its children. */
export function NjspSection({ children }: { children: ReactNode }) {
    return (
        <NjspSectionProvider>
            <NjspSectionFilters />
            {children}
        </NjspSectionProvider>
    )
}
