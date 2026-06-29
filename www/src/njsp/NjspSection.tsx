import type { ReactNode } from "react"

/** Organizational wrapper for the NJSP plots + Recent-Fatal-Crashes table on
 *  the home page. Section-scoped filter state (year range, victim type) now
 *  lives on a higher-level `NjspSectionProvider` (lifted in `Home.tsx` to
 *  wrap the whole page) so the bar can render inside `GeoNavBar`; this
 *  component is just a transparent container kept for organizational clarity. */
export function NjspSection({ children }: { children: ReactNode }) {
    return <>{children}</>
}
