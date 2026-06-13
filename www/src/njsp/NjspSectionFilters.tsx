import { useTheme } from "@/src/contexts/ThemeContext"
import { StartYear, curYear } from "@/src/constants"
import { YearSelect } from "@/src/lib/year-select"
import { useNjspSection, NJSP_YEAR_RANGE_DEFAULT } from "./NjspSectionContext"

/** Compact filter bar for the NJSP section: year-range pair (start–end). */
export function NjspSectionFilters() {
    const { actualTheme } = useTheme()
    const section = useNjspSection()
    if (!section) return null
    const { yearRange, setYearRange, yearRangeActive } = section
    return (
        <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center",
            justifyContent: "center", gap: 6,
            fontSize: "0.95em", color: "var(--text-secondary)",
            margin: "0.4em 0 0.8em",
        }}>
            <span>Years:</span>
            <YearSelect
                value={yearRange[0]} min={StartYear} max={yearRange[1]}
                onChange={y => setYearRange([y, yearRange[1]])}
                theme={actualTheme}
            />
            <span>–</span>
            <YearSelect
                value={yearRange[1]} min={yearRange[0]} max={curYear}
                onChange={y => setYearRange([yearRange[0], y])}
                theme={actualTheme}
            />
            {yearRangeActive && (
                <button
                    type="button"
                    onClick={() => setYearRange(NJSP_YEAR_RANGE_DEFAULT)}
                    style={{
                        background: "transparent",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-color, #ccc)",
                        borderRadius: 3,
                        padding: "1px 6px",
                        cursor: "pointer",
                        fontSize: "0.9em",
                    }}
                    title="Reset to full range"
                >reset</button>
            )}
        </div>
    )
}
