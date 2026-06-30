import type { ReactNode } from "react"
import { useTheme } from "@/src/contexts/ThemeContext"
import { StartYear, EndYear } from "@/src/constants"
import { YearSelect } from "@/src/lib/year-select"
import { useNjdotSection, NJDOT_YEAR_RANGE_DEFAULT } from "./NjdotSectionContext"

/** Inline filter bar for the NJDOT section (year range). Sits at the top
 *  of the NJDOT block — not in `GeoNavBar` (unlike `NjspSectionFilters`)
 *  because NJDOT is far down the page, so a sticky top-of-screen
 *  position adds less value than co-locating filters with the plots. */
function NjdotSectionFilters() {
    const { actualTheme } = useTheme()
    const section = useNjdotSection()
    if (!section) return null
    const { yearRange, setYearRange, yearRangeActive } = section
    return (
        <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center",
            gap: 12, marginBottom: 12,
            fontSize: "0.9em", color: "var(--text-secondary)",
        }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                <YearSelect
                    value={yearRange[0]} min={StartYear} max={yearRange[1]}
                    onChange={y => setYearRange([y, yearRange[1]])}
                    theme={actualTheme}
                    short
                />
                <span>–</span>
                <YearSelect
                    value={yearRange[1]} min={yearRange[0]} max={EndYear}
                    onChange={y => setYearRange([yearRange[0], y])}
                    theme={actualTheme}
                    short
                />
            </span>
            {yearRangeActive && (
                <button
                    type="button"
                    onClick={() => setYearRange(NJDOT_YEAR_RANGE_DEFAULT)}
                    style={{
                        background: "transparent",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-color, #ccc)",
                        borderRadius: 3,
                        padding: "1px 5px",
                        cursor: "pointer",
                        fontSize: "0.95em",
                        lineHeight: 1,
                    }}
                    title="Reset year range"
                    aria-label="Reset year range"
                >↻</button>
            )}
        </div>
    )
}

/** Organizational wrapper for the NJDOT plot + tables on the home page.
 *  Renders an inline filter bar (year range) at the top, and a transparent
 *  pass-through for children. Section-scoped filter state comes from
 *  `<NjdotSectionProvider>` (mounted up-stack in `Home.tsx`). */
export function NjdotSection({ children }: { children: ReactNode }) {
    return (
        <>
            <NjdotSectionFilters />
            {children}
        </>
    )
}
