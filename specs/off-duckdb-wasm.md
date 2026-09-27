# Off DuckDB-WASM: app data reads via hyparquet

Branch: `off-duckdb-wasm` (from `map-mode-heatmap-on-cells` @ `d4c9ef0fe26`).

## Why

DuckDB-WASM (1.28 / DuckDB 0.9.1) is loaded on every page (`DuckDbProvider` wraps `App`): a ~7 MB wasm + worker from unpkg, a slow cold start, and an old engine — `IN` / `OR` filters don't prune row groups, and there's no `parquet_kv_metadata`. Upgrading it is its own project (`duckdb-up` @ `b2833f9b821`, on hold). The app's queries are almost all "read these columns from the row groups where `key = X` / `key` in a range / `key IN (…)`", plus small group-by sums over ≤ 250 KB files. hyparquet (already a dependency) does targeted range reads well.

Target: app pages never load DuckDB-WASM. It's lazy-loaded only by `/sql` (the REPL), which keeps working exactly as today; "Open in SQL ↗" links are plain `/sql?q=…` / `/sql?path=…` hrefs.

## Inventory (DuckDB-WASM uses at `d4c9ef0fe26`)

Infra:
- `www/src/lib/DuckDbContext.tsx`: `DuckDbProvider` (mounted in `App.tsx`, i.e. every route), `useDb`, `runQuery`, `useQuery`, `useQueryState`.
- `www/src/tableData.ts`: `useRegisteredParquetDb` / `useRegisteredDb` (fetch a whole file, register it in DuckDB), `useTable`, `useCsvTable`, `useSqliteDb` (legacy).

Road data (`www/src/map/roads/roadsData.ts`, over `…/njdot/roads/*.parquet`, ZSTD, stats only on sort keys):

| fn | file | SQL shape | callers |
|---|---|---|---|
| `fetchHitPoints` | `sri-hit{,-5,-6}` | `lon BETWEEN … AND lat BETWEEN …` | `useRoadSelection` (map hover) |
| `fetchEntity` | `road-entities` | `entity = ?` | `HoverDrawer`, `useRoadEntity`, `useRoadScope` (corridor members) |
| `fetchEntityBySlug` | `road-entities` | `slug = ?` | `useRoadEntity` (`/road/<slug>`) |
| `fetchEntitySummary` | `road-summary[-monthly]` | `entity = ?`, present-cols | `useRoadSelection`, `RoadPage` |
| `fetchCorridorSummary` | `road-corridor-summary-monthly` | `corridor = ?` | `useRoadScope` |
| `fetchRoadRanks` | `road-ranks` | `cc = ? AND mc = ?` | `RoadRanksSection` (home page, county / muni) |
| `fetchEntityGeom` | `sri-geom` | `entity = ?` `ORDER BY sri, mp` | `useRoadSelection`, `RoadPage`, `CrashDetailPage`, `useRoadScope` |
| `fetchEntityCrashes[Full]` | `crashes-by-entity` | `entity = ?` `ORDER BY chain IS NULL, chain, dt` | `useRoadScope`, `RoadCrashTable` (CSV export) |
| `fetchEntityXs` | `crashes-by-entity-xs` | `entity = ?` [+ span] `ORDER BY chain, dt` | `useRoadScope` |
| `fetchSpanCrashes` | `crashes-by-entity` | `UNION ALL` of span + pinned-unplaced scans | `useRoadScope` |
| `fetchBlocks` | `road-blocks` | `entity = ?` `ORDER BY block` | `useRoadScope` |
| `fetchCorridor` | `road-corridors` | `corridor = ?` | `useRoadScope` |
| `fetchEntityNames` | `road-entities` | one `BETWEEN` scan per id cluster (no `IN` pruning) | `useRoadScope` |
| `fetchCrashEntity` | `crashes-by-sri` | `sri = ? AND (id = ? OR (id IS NULL AND pk))` | `CrashDetailPage` |
| `fetchRoadInfo`, `fetchRoadCrashes` | `sris`, `crashes-by-sri` | `sri = ?` | (unused) |
| `searchRoads` | `road-search` | one scan per exact token + one prefix range; kv `capped_tokens` via a separate hyparquet footer read | `useRoadSearch` (omnibar) |

`scopeSql.ts` (and the `*Sql` builders it uses) only builds the "Open in SQL" query text; it stays.

NJSP plots (`www/public/njsp/*.parquet`, SNAPPY, 1 row group each, 7–255 KB; `projected.csv` 15 KB):
- `FatalitiesPerYearPlot`: `year-type-county` group-by-year sums (county filter); `monthly` group-by-year sums + monthly rows (statewide / county / muni filter); `projected.csv` summed.
- `FatalitiesByMonthBarsPlot`: `monthly` rows.
- `YtdDeathsPlot`: `ytd` rows.
- `HomicidesComparisonPlot`: `crash-homicide` rows; `year-type-county` group-by-year sums.
- Dead: `FatalitiesPerMonthPlot.tsx`, `njsp/plot.tsx` (only its `Annotation` type is used), `njsp/projections.ts`.

Not DuckDB: `njdot/CrashPlot.tsx` and crash tables (cells API / D1 API), `/raw/*` + `ParquetViewer` (hyparquet already), map layers (hyparquet / cells API). `/sql` (`SqlPage.tsx`) is the one real SQL consumer.

## Design: `www/src/lib/pq/`

- **Source / metadata cache** (`source.ts`): `openParquet(url)` is memoized per URL. One suffix-range read (`Range: bytes=-N`, default 256 KiB) gets the footer and the file length (`Content-Range`, which the R2 bucket exposes via CORS); a footer bigger than that (e.g. `crashes-by-entity`: 1.05 MB) costs one more read of exactly the missing bytes. Files smaller than the first read (all NJSP files) arrive whole in that one request and are served from memory thereafter. Every later read of that URL reuses the parsed `FileMetaData` (DuckDB-WASM re-read the footer unless `enable_object_cache` hit).
- **Pruning** (`filter.ts`): a small typed filter (`{ col: value }` = eq; `{ col: { $in, $gt, $gte, $lt, $lte, $ne, $null } }`; `$and` / `$or`), evaluated against each row group's column statistics (`min_value`/`max_value`, `null_count`) — equality, ranges, `IN` lists, `IS [NOT] NULL`, and `OR`s all prune. Rows are then matched with SQL null semantics (a comparison with null is false).
- **Reads** (`query.ts`): `readRows(url, { columns, filter, orderBy, limit })`: prune row groups, compute the needed column chunks' byte ranges, coalesce ranges < 64 KiB apart, fetch them in parallel, decode with hyparquet (ZSTD via `fzstd`), normalize values to what `runQuery` returned (INT64 `bigint` → `number`, timestamps → epoch ms), filter, project, sort (nulls last, like DuckDB's default), limit. `columns` is present-only, like the old `COLUMNS('^(…)$')`: columns a build doesn't have are just absent from rows.
- **Ops** (`ops.ts`): `sortRows`, `groupSum` for the plots' `GROUP BY year` sums.
- **kv metadata**: `kvMetadata(url)` reads it from the cached footer (`road-search`'s `capped_tokens`), no separate fetch.

## Migration plan (phases, each a working checkpoint)

1. Data layer + tests (vitest, exact-equality assertions; small checked-in parquet fixtures written by a pyarrow script next to them: several row groups, ZSTD, stats).
2. Road paths: `roadsData.ts` / `roadSearch.ts` fetchers drop their `db` arg and read via `pq`; hooks drop `useDb` / `!!db` gating. Corridor-member / cross-street-name lookups become single `$in` reads; span crashes a single `$or` read.
3. NJSP plots: read the small files once, filter / group in JS (react-query for caching).
4. Lazy DuckDB: `DuckDbProvider` moves from `App` into `SqlPage`; dead DuckDB code (`tableData.ts`, legacy plot files) removed. Verify no `@duckdb/duckdb-wasm` in the main / route chunks.

## Parity

Per ported query, compare to DuckDB on the real files: a vitest (`src/lib/pq/parity.test.ts`) runs each ported fetch through `pq` over local files and the original SQL through the `duckdb` CLI (skipped when either is unavailable), asserting equal rows.

## Status

- [ ] Phase 1: data layer
- [ ] Phase 2: road paths
- [ ] Phase 3: NJSP plots
- [ ] Phase 4: lazy DuckDB, dead code
- [ ] Measurements (before → after)
