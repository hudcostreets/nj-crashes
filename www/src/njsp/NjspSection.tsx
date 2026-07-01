import type { ReactNode } from "react"

/** Organizational wrapper for the NJSP plots + Recent-Fatal-Crashes table on
 *  the home page. Filter state (year range, victim type) lives on the
 *  page-level `PageFiltersProvider` (mounted in `Home.tsx`) so the bar can
 *  render inside `GeoNavBar` and cascade to both the NJSP and NJDOT
 *  sections; this component is just a transparent container kept for
 *  organizational clarity. */
export function NjspSection({ children }: { children: ReactNode }) {
    return <>{children}</>
}
