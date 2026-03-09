# Unified SPA: Geo-Filtered Single View

Merge Home, CrashRegion, and NjspRegion into one view. URL reflects geo filter state:
- `/` = all NJ
- `/c/hudson` = filtered to Hudson County
- `/c/hudson/jersey-city` = filtered to Jersey City, Hudson County
- `/njsp/hudson` = same data, NJSP perspective (or just merge into `/c/` routes)

## Architecture

### One View, Not Separate Pages

Currently Home.tsx has all the plots (5 NJSP + 1 NJDOT CrashPlot + Hudson map iframe), while `/c/:county` and `/njsp/:county` are empty stubs. Instead of building separate page components:

- **Home becomes the universal view** — it renders all plots, filtered by geo context
- Selecting a county in a dropdown or clicking a county name **navigates** to `/c/:county`
- `/c/:county` renders the same Home component, with geo filter pre-set from route params
- Going back to `/` clears the geo filter (shows all NJ)

### Route Consolidation

```
/                       → <MainView />              (geo: all NJ)
/c/:county              → <MainView />              (geo: county)
/c/:county/:city        → <MainView />              (geo: municipality)
/njsp                   → redirect to / or remove
/njsp/:county           → redirect to /c/:county
```

Delete `CrashRegion.tsx` and `NjspRegion.tsx` stubs. All routes render the same component.

## Global Filter Context

### `useGeoFilter()` Hook

Reads from route params + URL query params, provides to all plots:

```ts
type GeoFilter = {
    county: number | null     // cc code, from route param
    municipality: number | null  // mc code, from route param
    countyName: string | null
    municipalityName: string | null
}
```

Route param → code resolution uses `cc2mc2mn.json` (already loaded).

### Additional URL Params (Later)

These are lower priority and can be added incrementally:
- `?y0=&y1=` year range
- `?sev=` severity filter
- `?vt=` victim type

For now, geo from route params is the main filter. Plot-local controls (stack mode, colorscale, time granularity, etc.) stay as-is.

## Plot Integration

### How Each Plot Consumes the Geo Filter

| Plot | County Filter | Municipality Filter |
|------|--------------|---------------------|
| CrashPlot (NJDOT) | ✓ already has `counties` prop | needs `mc` in data (see below) |
| FatalitiesPerYearPlot | ✓ NJSP data has county | ✗ NJSP is county-level |
| YtdDeathsPlot | ✓ | ✗ |
| FatalitiesPerMonthPlot | ✓ | ✗ |
| FatalitiesByMonthBarsPlot | ✓ | ✗ |
| HomicidesComparisonPlot | ? check data | ✗ |

When filtered to a municipality:
- NJSP plots show county-level data with a note ("showing Hudson County — NJSP data is county-level")
- CrashPlot filters to municipality (if data supports it)

### CrashPlot Changes
- Accept optional `county`/`municipality` from geo filter context
- When geo filter is active, pre-set and lock the county selector
- Remove CrashPlot's internal county dropdown when global filter is active (avoid redundancy)

### NJSP Plot Changes
- Each NJSP plot needs to accept an optional `county` prop
- Filter its data (JSON-based) to the selected county
- Check: do the NJSP JSON files already have county-level breakdowns?
  - `year-type-county` data suggests yes

## Geo Data Available

### County Boundaries
- `Municipal_Boundaries_of_NJ.geojson` (27MB, 564 munis) — dissolve by county to get county boundaries
- Pre-compute: generate `counties.geojson` (21 features) and individual `county/<cc>.geojson` files
- Or: load full muni GeoJSON once, filter client-side (27MB is large for initial page load though)

### Municipality Boundaries
- Same `Municipal_Boundaries_of_NJ.geojson`, filter by `MUN_CODE` prefix (county code)
- For muni pages: extract relevant features client-side, or pre-split per county

### Crash Locations (for Maps)
- `crashes.parquet` has `olat`/`olon` columns (6.6M+ rows, too large for browser)
- Options:
  1. Pre-compute per-county parquet with just `(olat, olon, severity, year)` — lightweight
  2. Query `crashes.db` via DuckDB-WASM with `WHERE cc = ?`
  3. Start without maps, add later (maps are deprioritized per discussion)

## Header / Navigation

When geo filter is active, show:
- Breadcrumbs: **New Jersey** > **Hudson County** > **Jersey City**
- Each breadcrumb is a link (Jersey City → `/c/hudson/jersey-city`, Hudson → `/c/hudson`, NJ → `/`)
- County/municipality name in the page title and `<Head>` og tags

When no filter: show "New Jersey" as the region, with a county selector dropdown.

## Map Section

- Show map when we have boundary + crash location data for the selected region
- Hide map section (don't show empty placeholder) when data isn't available
- Initially: only show map for Hudson County (existing data), expand as we generate data for others
- Map is optional for landing — the plots are the primary content

## Municipality-Level Data

### Current State
- `ymccs.parquet` schema: `(y, m, cc, s, n)` — has county but NOT municipality
- `cmymc.db` likely has muni-level data (name suggests county-muni-year-month-count)

### Options
1. **Query `cmymc.db` via DuckDB-WASM** for muni-level CrashPlot data
   - Pro: no new data files, DB already exists and is served
   - Con: adds DuckDB-WASM dependency to CrashPlot (currently uses parquet)
2. **Generate `ymccsmcs.parquet`** (year × month × county × muni × severity)
   - Pro: consistent with existing parquet-based approach
   - Con: another file to generate/serve
3. **Skip muni-level CrashPlot initially** — show county-level data with note
   - Pro: fastest to ship
   - Con: `/c/:county/:city` has same plots as `/c/:county`

Recommendation: option 3 for landing, then option 1 or 2 as follow-up.

## Implementation Order

### Phase 1: Unified View (Required for Landing)
1. Create `useGeoFilter()` context reading from route params
2. Refactor routes: all geo routes → single component (extend Home or replace)
3. Wire CrashPlot to consume geo filter (county only, lock its internal county dropdown)
4. Wire NJSP plots to consume geo filter (county only)
5. Add breadcrumb navigation + county selector
6. Update `<Head>` with geo-specific title/description
7. Delete `CrashRegion.tsx` and `NjspRegion.tsx` stubs

### Phase 2: Maps (Post-Landing)
1. Generate `counties.geojson` from municipal boundaries (dissolve)
2. Generalize `HudsonMap` → `CrashMap` component
3. Pre-compute per-county crash location data
4. Show map section when data available

### Phase 3: Municipality Detail (Post-Landing)
1. Generate or query muni-level aggregated data
2. Filter plots to municipality when in `/c/:county/:city`
3. Show muni boundary on map
