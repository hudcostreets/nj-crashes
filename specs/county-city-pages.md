# County and City Pages

Implement the stub routes at `/c/:county` and `/c/:county/:city` with real crash data, maps, and plots.

## Current State

- Routes defined in `App.tsx` lines 19-21, handled by `CrashRegion.tsx`
- `CrashRegion` is a stub ("coming soon") that parses URL params but shows no data
- County/city names normalized via `normalize()`/`denormalize()` helpers
- `cc2mc2mn.json` provides county code → muni code → muni name mapping
- `CrashPlot` already supports county and severity filtering via controls
- Hudson County map exists at `/map/hudson` using Leaflet (hardcoded to Hudson)

## County Page (`/c/:county`)

### Layout
1. **Header**: County name, total crash count, date range
2. **Map**: Interactive crash map for the county (generalize `/map/hudson` to any county)
   - Crash locations from NJDOT data (lat/lng fields)
   - Color-coded by severity (fatal/injury/PDO)
   - Clustered at lower zoom levels
3. **CrashPlot**: Filtered to this county, stacked by severity (default)
   - Pre-set `counties` prop to just this county's code
   - Keep controls drawer for severity filtering, time granularity, etc.
4. **Municipality table**: List of municipalities with crash counts, linked to `/c/:county/:city`
5. **NJSP fatalities section** (if data available): Fatal crash trends from NJSP for this county

### Data
- NJDOT: `ymccs.parquet` already has per-county-month-severity data
- For maps: need geocoded crash locations (lat/lng from `crashes.parquet` or a lighter derivative)
  - Consider a pre-computed parquet per county with just location + severity + year, to keep page loads fast
  - Or use DuckDB-WASM to query `crashes.db` on the client
- County boundaries: need GeoJSON for all 21 counties (currently only have `hudson.geojson`)
  - Source from NJGIN or US Census TIGER/Line

### URL State
- Map center/zoom in URL params (reuse `useMapState` from Hudson map)
- Year range filter in URL params (so links can share specific views)

## City/Municipality Page (`/c/:county/:city`)

### Layout
1. **Header**: Municipality name, county, crash count, date range
2. **Map**: Zoomed to municipality boundary
   - Need municipality boundary GeoJSON (from NJGIN)
3. **CrashPlot**: Filtered to this municipality
   - Requires extending `CrashPlot` or its data source to filter by `mc` (municipality code)
   - Current `ymccs.parquet` has `cc` but may not have `mc` — check schema
4. **Summary stats**: Fatalities, injuries, PDO counts; trends vs prior years

### Data Gaps
- Check if `ymccs.parquet` includes `mc` column or just `cc`
  - If not, may need a `ymccsmcs.parquet` (year × month × county × muni × severity)
  - Or query `crashes.db` / `cmymc.db` directly via DuckDB-WASM
- Municipality boundary GeoJSON needed for all ~565 municipalities

## Shared Components

### Generalized Map Component
Extract from `HudsonMap.tsx` into a reusable `CrashMap` that accepts:
- `boundaryUrl`: GeoJSON URL for the region boundary
- `crashDataUrl`: URL for crash location data
- `center` / `zoom` defaults (or auto-fit to boundary bbox)

### Region Navigation
- Breadcrumbs: Home → County → Municipality
- Sidebar or dropdown for navigating between counties/municipalities
- Links between NJSP (`/njsp/:county`) and NJDOT (`/c/:county`) views of same county

## Implementation Order
1. Generate county boundary GeoJSON files (all 21 counties)
2. Generalize `HudsonMap` → `CrashMap` component
3. Build county page with map + filtered CrashPlot
4. Add municipality table with links
5. Build municipality page (needs muni boundaries + mc-level data)
6. Add breadcrumb navigation
