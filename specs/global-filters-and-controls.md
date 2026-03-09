# Global Filters and Controls

Add site-wide filtering controls that apply across all plots on a page, with graceful degradation when a plot lacks the required data dimensions.

## Problem

Currently each plot has its own independent controls:
- `CrashPlot`: county, severity, time granularity, stack mode (via controls drawer)
- NJSP plots: colorscale, legend position, YTD mode (via controls drawer)
- No shared state between plots on the same page

When a user is looking at Hudson County data, they want all plots on the page to reflect that — not just one.

## Proposed Global Controls

### Geography Filter
- **County**: dropdown or multi-select (default: all NJ)
- **Municipality**: dropdown, only enabled when a single county is selected
- Synced to URL: `/c/hudson` pre-sets county=Hudson, `/c/hudson/jersey-city` pre-sets both
- When on a county/city page, the geo filter is pre-set and optionally locked

### Time Range Filter
- **Year range**: start year to end year (slider or dual dropdown)
- Default: full range (2001-2023 for NJDOT, 2008-present for NJSP)
- Synced to URL params: `?y0=2018&y1=2023`

### Severity Filter
- **Severity**: checkboxes for Fatal, Injury, PDO
- Default: all selected
- Synced to URL params: `?sev=f,i` (fatal + injury only)

### Victim Type Filter
- **Type**: Drivers, Occupants, Pedestrians, Cyclists
- Relevant for plots that break down by victim type (NJSP fatalities by type)
- Not all plots support this dimension

## Graceful Degradation

Not all plots have all data dimensions. When a global filter doesn't apply:

| Filter | CrashPlot (NJDOT) | NJSP Fatal Plots | Maps |
|--------|-------------------|------------------|------|
| County | ✓ (has `cc`) | ✓ (has county) | ✓ (filter markers) |
| Municipality | ? (needs `mc` in aggregated data) | ✗ (NJSP is county-level) | ✓ |
| Year range | ✓ | ✓ | ✓ |
| Severity | ✓ | ✗ (NJSP = fatal only) | ✓ |
| Victim type | ✗ (crashes not victims) | ✓ (by type) | ✗ |

When a filter doesn't apply to a plot:
- Show a subtle indicator (dimmed filter chip or tooltip) explaining why
- Don't hide the plot — still show it with available data
- Example: NJSP fatal plot ignores severity filter but shows note "NJSP data includes fatal crashes only"

## Implementation

### State Management
- Create a `useGlobalFilters()` hook or React context
- Reads initial values from URL params and route params
- Provides filter state + setters to all plot components
- Updates URL params on change (via `use-prms`)

### URL Param Schema
```
?cc=03          # county code (or comma-separated for multi)
?mc=38          # municipality code (single county only)
?y0=2018        # start year
?y1=2023        # end year
?sev=f,i,p      # severity: f=fatal, i=injury, p=PDO
?vt=ped,cyc     # victim type filter
```

### Integration with Existing Plot Controls
- Plot-specific controls (stack mode, colorscale, etc.) stay local to each plot
- Global filters override/pre-set the corresponding plot-local filters
- If a plot has its own county selector, it's synced with the global one
  - Or: remove per-plot county selectors in favor of global, to reduce redundancy

### Control Bar UI
- Sticky bar below the site header (or collapsible sidebar)
- Compact: show active filters as chips, click to expand full controls
- On county/city pages: geography is shown as breadcrumbs + locked filter
- On home page: all filters available

## Data Requirements

### Current Data Availability
- `ymccs.parquet`: year × month × county × severity counts — supports county + severity + time
- `yms.parquet`: year × month × severity counts (state-level) — supports severity + time
- NJSP JSON data: by year × month × type × county — supports county + time + victim type

### Gaps
- Municipality-level aggregated data for CrashPlot (currently only county-level in `ymccs`)
  - Need `ymccsmcs.parquet` or query `cmymc.db` via DuckDB-WASM
- Cross-source consistency: NJDOT county codes ≠ NJSP county codes
  - Municipality code harmonization already done (`muni_codes.parquet`)
  - Need a county name → code lookup that works for both sources

## Implementation Order
1. Define `useGlobalFilters()` context + URL param sync
2. Wire into `CrashPlot` (replace its internal county/severity state when global is active)
3. Wire into NJSP plots (county filter, year range)
4. Build the control bar UI
5. Integrate with county/city page routes (pre-set filters from URL)
6. Add graceful degradation indicators
