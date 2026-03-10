# Unified SPA: Geo-Filtered Single View

## Status: Phase 1 DONE, Phases 2-3 remain

Phase 1 (unified view with geo filtering) is implemented:
- `GeoFilterContext` reads county/municipality from route params
- All routes render `Home` wrapped in `GeoFilterProvider`
- NJSP plots filter by county via DuckDB queries
- CrashPlot filters by county code prop
- Breadcrumbs, county selector, `<Head>` og tags all geo-aware
- DuckDB shared singleton via `DuckDbProvider`

### Key files
- `www/src/GeoFilterContext.tsx` — route params → `{ cc, mc, countyName, municipalityName }`
- `www/src/routes/Home.tsx` — renders all plots with geo filter
- `www/src/lib/DuckDbContext.tsx` — shared DuckDB instance, `useDb`, `useQuery`, `runQuery`
- `www/src/App.tsx` — all `/c/:county` etc. routes → `GeoHome`

## Remaining: Phase 2 — Maps

Generalize Hudson-only map to all counties, municipalities, and statewide. See `county-maps-and-og-images.md`.

## Remaining: Phase 3 — Municipality detail

- `ymccs.parquet` has county but NOT municipality
- Options: query `cmymc.db` via DuckDB-WASM, or generate `ymccsmcs.parquet`
- For now, municipality pages show county-level NJSP plots with a note, and CrashPlot filtered to municipality (if data supports it)

## Remaining: Phase 4 — Table views

See `table-views.md`.
