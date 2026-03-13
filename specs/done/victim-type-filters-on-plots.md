# Victim type filters on NJSP plots

## Status: Partially implemented (2026-03-13)

### Implemented

| Plot | What was done |
|------|---------------|
| `FatalitiesByMonthBarsPlot` | Victim type multi-select dropdown (outside gear, `<details>` with checkboxes + click-to-solo). Filters which types are summed into bar values. |
| `FatalitiesPerYearPlot` | Already stacks by type. "By Month" mode: 12-mo avg line now respects solo'd type (computed client-side instead of using precomputed `avg_12mo`). Avg line color tinted toward solo'd type. |
| `FatalitiesPerYearPlot` | Added `cc`/`mc` props for city-level support. Yearly mode aggregates from `monthly.csv` for muni level (since `ytc.csv` only has county data). |

### Data notes

- `monthly.csv` has per-type columns (`driver`, `passenger`, `pedestrian`, `cyclist`) at statewide, county, and municipality levels
- Pre-2020 county/muni rows have all type columns = 0 (type breakdown wasn't in NJSP daily feed until 2020). Only statewide rows have pre-2020 type data (backfilled from annual report PDFs)
- `FatalitiesPerYearPlot` "By Month" mode handles this: when all type columns are 0, shows full `fatalities` count on the Drivers bar as fallback

### Not yet implemented

- `FatalitiesPerMonthPlot`: No victim type stacking/filtering added yet
- `YtdDeathsPlot`: No victim type filtering
- `HomicidesComparisonPlot`: No pedestrian-only filter option
- Shared `VictimTypeFilter` component: Not extracted (FatalitiesByMonthBarsPlot has its own inline `VictimTypeDropdown`)
- URL state persistence (`?vt=d,p`): Not implemented; using sessionStorage instead
