# Unified SPA: Geo-Filtered Single View

## Status: DONE

Implemented:
- `GeoFilterContext` reads county/municipality from route params
- All routes render `Home` wrapped in `GeoFilterProvider`
- NJSP plots filter by county via DuckDB queries on static CSVs
- NJDOT CrashPlot filters by county+municipality (loads `ymccmcs/{cc}.parquet`)
- NJDOT tables (year-stats, crashes) filter by cc+mc via D1 API
- NJSP crashes table filters by cc+mc via D1 API
- Breadcrumbs, county selector, `<Head>` og tags all geo-aware
- DuckDB shared singleton via `DuckDbProvider`

### Key files
- `www/src/GeoFilterContext.tsx` — route params → `{ cc, mc, countyName, municipalityName }`
- `www/src/routes/Home.tsx` — renders all plots with geo filter
- `www/src/lib/DuckDbContext.tsx` — shared DuckDB instance
- `www/src/App.tsx` — all `/c/:county` etc. routes → `GeoHome`
- `api/src/index.ts` — D1 API endpoints with cc/mc filtering

### Remaining work tracked in other specs
- NJSP plots at muni level: `njsp-muni-level-data.md`
- Maps: `county-maps-and-og-images.md`
- Crash detail pages: `crash-detail-pages.md`
