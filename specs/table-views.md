# Table views

## Context

The production site had three table views (NJSP fatal crashes, NJDOT crash details, annual stats) that were lost during the Next.js → Vite migration. The components and hooks still exist but aren't wired into any routes.

### Existing infrastructure (all unused)

| File | Purpose |
|------|---------|
| `result-table.tsx` | Generic MUI table renderer with error handling |
| `use-njsp-crashes.tsx` | NJSP fatal crash rows (paginated by page #) |
| `use-njdot-crashes.tsx` | NJDOT injury/fatal crash rows (paginated by date) with vehicle/injury detail icons |
| `use-year-stats.ts` | Annual crash/injury/death statistics by year |
| `pagination.tsx` | Page-based and date-based pagination controls |

### Data sources

- **NJSP crashes**: SQLite database (`urls.njsp.crashes`), fatal crashes 2008-present
- **NJDOT crashes**: Database (`urls.dot.crashes`), all crashes 2001-2023 filtered to injury+fatal
- **Year stats**: Pre-aggregated NJDOT stats by year and condition

All queries accept `cc`/`mc` filters for county/municipality scoping.

## Plan

### 1. Wire tables into `Home.tsx`

Add table sections below the plots on the unified SPA view. Each table is geo-filtered by the same `useGeoFilter()` context the plots use.

```
[NJSP Plots]
[NJ DOT CrashPlot]
[Map (when available)]

--- Tables ---

[Annual Statistics Table]      ← useYearStats, always shown
[Recent Fatal Crashes (NJSP)]  ← useNjspCrashRows, paginated
[Crash Details (NJDOT)]        ← useNjdotCrashRows, date-paginated
```

### 2. Adapt hooks to use shared DuckDB

The table hooks currently use the old `@rdub/duckdb` or `@rdub/react-sql.js-httpvfs` patterns. They need to be updated to:
- Use `useDb()` from `DuckDbContext` (shared singleton)
- Use `runQuery()` that properly closes connections
- Or use `useQuery()` hook for simple cases

Check each hook's data source:
- `useNjspCrashes`: uses `useSqliteDb` from `tableData.ts` — needs SQLite scanner extension in DuckDB-WASM, or keep as separate fetch+query
- `useNjdotCrashes`: similar pattern
- `useYearStats`: similar pattern

### 3. County/municipality filtering

Each table hook already accepts `cc`/`mc` params for SQL WHERE clauses. Wire these from `useGeoFilter()`:
- Statewide (`/`): no filter (show all, most recent first)
- County (`/c/hudson`): `WHERE cc = 9`
- Municipality (`/c/hudson/jersey-city`): `WHERE cc = 9 AND mc = ?`

### 4. Responsive layout

Tables can be wide. Options:
- Horizontal scroll on mobile
- Hide less-important columns on narrow viewports
- Collapsible detail rows (click to expand vehicle/injury details)

### 5. Link to crash detail pages

Each table row should link to `/crash/:year/:cc/:mc/:case` (per `crash-detail-pages.md`). Initially these pages won't exist, so just show the data inline. Add links when crash detail pages are built.

## Implementation order

1. **Annual stats table** — simplest, no pagination, just yearly aggregates. Good smoke test for the data pipeline.
2. **NJSP fatal crashes table** — page-based pagination, moderate complexity.
3. **NJDOT crash details table** — date-based pagination, rich icons, most complex.

## Database availability

Check which databases are currently served from `www/public/`:
- NJSP crashes SQLite/DB
- NJDOT crashes DB
- Year stats aggregation DB

If they're not currently served, need to either:
- Add them to `public/` (or `public/data/`)
- Generate them in the `update_www_data` pipeline
- Use DuckDB-WASM to query parquet files directly (preferred for new code)
