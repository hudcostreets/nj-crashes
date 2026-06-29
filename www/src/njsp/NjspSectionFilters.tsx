import { useTheme } from "@/src/contexts/ThemeContext"
import { StartYear, curYear } from "@/src/constants"
import { YearSelect } from "@/src/lib/year-select"
import { useNjspSection, NJSP_YEAR_RANGE_DEFAULT, NJSP_TYPES_DEFAULT } from "./NjspSectionContext"
import { VictimTypeDropdown } from "./victim-types"

/** Compact filter bar for the NJSP section: year-range pair + victim-type
 *  multi-select. Both cascade to plots and (year only) the table below. */
export function NjspSectionFilters() {
    const { actualTheme } = useTheme()
    const section = useNjspSection()
    if (!section) return null
    const { yearRange, setYearRange, yearRangeActive, selectedTypes, setSelectedTypes, typesActive } = section
    const anyActive = yearRangeActive || typesActive
    return (
        <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center",
            gap: 12,
            fontSize: "0.9em", color: "var(--text-secondary)",
            // Lives inline inside `GeoNavBar` — the nav supplies the sticky
            // positioning + backdrop. Push to the right of the breadcrumb.
            marginLeft: "auto",
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
                    value={yearRange[1]} min={yearRange[0]} max={curYear}
                    onChange={y => setYearRange([yearRange[0], y])}
                    theme={actualTheme}
                    short
                />
            </span>
            <VictimTypeDropdown selected={selectedTypes} onChange={setSelectedTypes} />
            {anyActive && (
                <button
                    type="button"
                    onClick={() => {
                        if (yearRangeActive) setYearRange(NJSP_YEAR_RANGE_DEFAULT)
                        if (typesActive) setSelectedTypes(NJSP_TYPES_DEFAULT)
                    }}
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
                    title="Reset all filters"
                    aria-label="Reset all filters"
                >↻</button>
            )}
        </div>
    )
}
