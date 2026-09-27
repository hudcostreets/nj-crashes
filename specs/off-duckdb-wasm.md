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

- **Source / metadata cache** (`source.ts`): `openParquet(url)` is memoized per URL. One suffix-range read (`Range: bytes=-N`, default 64 KiB) gets the footer and the file length (`Content-Range`, which the R2 bucket exposes via CORS); a footer bigger than that (road footers are 15 KB–1.05 MB) costs one more read of exactly the missing bytes. (A 256 KiB default saved that RTT but wasted ~200 KB per small-footer file, e.g. tripling `road-ranks` bytes.) The NJSP plots pass `tail: 256 KiB`, so each of their files (≤ 255 KB) arrives whole in one request. Vite's dev server (sirv) answers `bytes=-N` with the file's *head*; `httpRangeFetch` detects that from `Content-Range` and re-asks for the tail explicitly. Every later read of that URL reuses the parsed `FileMetaData` (DuckDB-WASM re-read the footer unless `enable_object_cache` hit).
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

- `www/src/map/roads/roadsData.parity.test.ts`: every road fetcher (entity by id / slug, summaries, corridor + its summary, ranks, geom, hit bbox, entity crashes view + full, `-xs` whole / block span / chain span, span crashes (block / chain / closed-end × v5.1 on/off), entity names, crash → entity by id and by PK, road search for 4 queries) through `pq` over the local files vs the replaced SQL via the `duckdb` CLI: equal as multisets, and the pq order checked against the `ORDER BY`. JFK Blvd: 36,157 crashes, identical.
- `www/src/njsp/data.parity.test.ts`: the NJSP selectors vs the replaced SQL, statewide / Hudson / the top muni, incl. a victim-type subset and `projected.csv` sums.
- Rendered-page A/B (`tmp/compare.mjs`, headless Chromium, before build vs after build): identical Plotly trace data and page text on `/`, `/c/hudson`, `/jersey-city`, `/c/atlantic`, and five `/road/…` views (span, whole, exact span, corridor scope `hudson-avenue?cor=1`, `xs=0`).

## Results (vite build + preview; road files from a local range server with 40 ms latency; headless Chromium, fresh context per run, median of 3)

Bundle: main `index.js` 4,012.7 → 3,834.0 kB (gzip 994.9 → 954.6 kB); `@duckdb/duckdb-wasm` JS moved to the `SqlPage` chunk (3.6 → 188.9 kB); app pages no longer fetch `duckdb-eh.wasm` + worker from unpkg (4.25 MB transferred per cold load). `fzstd` added (~8 kB).

| page | ready (ms) before → after | road bytes (MB) / requests before → after | DuckDB wasm+worker |
|---|---|---|---|
| `/` (NJSP plots drawn) | 2,004 → 530 | – | 4.25 MB → 0 |
| `/c/hudson` (plots; road ranks) | 2,936 → 477; ranks 2,887 → 563 | 2.68 / 20 → 2.04 / 5 | 4.25 MB → 0 |
| `/jersey-city` | 2,774 → 429 | 3.85 / 20 → 1.91 / 5 | 4.25 MB → 0 |
| `/road/hudson/j-f-kennedy-boulevard?span=6-7` (counts / rows / plots) | 4,894 / 4,894 / 4,894 → 837 / 837 / 886 | 4.46 / 66 → 3.39 / 20 | 4.25 MB → 0 |
| `/road/hudson/j-f-kennedy-boulevard` | 2,048 / 4,296 / 4,335 → 297 / 809 / 839 | 4.81 / 59 → 3.71 / 19 | 4.25 MB → 0 |
| `/map/hudson?road=hudson/j-f-kennedy-boulevard` (panel / rows) | 2,671 / 4,957 → 290 / 741 | 7.50 / 71 → 6.05 / 21 | 4.25 MB → 0 |

"Before" requests include DuckDB's HEAD per file per query; it also re-read footers (`crashes-by-entity`'s is 1 MB). Before-timings include the wasm download + instantiate; warm-cache before-timings (CIC, wasm cached) were ~1–2 s on `/` and ~4–5 s on road pages.

## Behavior differences

- An empty projection selection sums to 0 (SQL `sum` gave NULL; the plot's initial value was all-zeros anyway).
- Small NJSP files are fetched with a `Range` header, so a server that gzips whole responses (vite preview) sends them uncompressed (+~70 KB on `/`); CF Pages doesn't compress `.parquet`.
- `/sql` now initializes DuckDB on first visit (the Run button reads "Loading DuckDB…" until then).
- `e2e/perf-har/*.json` goldens still expect the DuckDB requests; regenerate with `pnpm test:perf:update`.

## Status

- [x] Phase 1: data layer (`804527d7936`)
- [x] Phase 2: road paths (`adf92422d31`)
- [x] Phase 3: NJSP plots (`07454ebf474`)
- [x] Phase 4: lazy DuckDB, dead code
- [x] Measurements (before → after)
- [ ] Regenerate `e2e/perf-har` goldens; drop the unused `@rdub/duckdb` dependency.
