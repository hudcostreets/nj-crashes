# Map data pipeline: PDO at all scales + per-hex `top_route`

Two related additions to `njdot export_map_data`. Frontend code already
reads the new shape (back-compat with old shards: missing fields are
treated as empty / 0). Outputs are DVX-tracked under
`www/public/njdot/map.dvc` — re-running on EC2 updates the bundle.

## What changed in code (this branch)

- `njdot/cli/export_map_data.py`
  - `_emit_hex_aggregates` now also emits a `top_route` column per
    `(h3, year, cc, mc)` bin: the **mode of the human-readable `road`**
    column ("CALDERON AVENUE", "ROUTE 9"), with `Route <N>` as a
    fallback when `road` is blank. Empty string when neither is known.
  - Point shards (`MAP_COLS`) now include `road` and `cross_street` so
    the per-crash tooltip can render "{road} at <cross_street> · MP".
  - Schema for `hex-r{N}/{year}.parquet`:
    `[h3, year, cc, mc, n_fatal, n_ped_inj, n_other_inj, n_pdo, top_route]`.
  - Schema for `by-year(/-county)/{year}.parquet` adds `road` and
    `cross_street` columns.
- `www/public/njdot/map.dvc`
  - Cmd updated: `njdot export_map_data -s i,f,p -H i,f,p` (PDO now
    included in **point** shards too — was `i,f`). Plus the existing
    `gen_county_outlines` and the new `gen_muni_outlines` chained.
- Frontend (`www/src/map/`)
  - `Crash.severity` extends to `"i" | "f" | "p"`. Adds optional
    `route?` so `binIntoHexes` can derive `topRoute` client-side.
  - `StackedHex.topRoute?: string` — populated server-side (from the
    new column) or client-side (from `binIntoHexes`).
  - `useCrashData` reads `top_route` from hex shards and aggregates a
    weighted mode across all loaded shards (year/cc/mc multi-shard
    fan-in).
  - `CrashTooltip` renders a "near `<top_route>`" line above the count
    when the bin has a non-empty top_route.
  - `Legend` `pdoEnabled` derives from `manifest.point_severities`
    (or hexbin scale). Once the rerun lands, PDO becomes selectable
    everywhere.

All changes are backward-compatible: pre-rerun shards (no `top_route`
column, no PDO points) still load; the TT line and PDO toggle just
stay empty/disabled until the rerun completes.

## What to do on EC2

1. `git pull` the branch.
2. `dvx status www/public/njdot/map.dvc` should show stale (deps
   themselves haven't changed, but the cmd has).
3. `dvx run www/public/njdot/map.dvc` — re-runs:
   - `njdot export_map_data -s i,f,p -H i,f,p` (the slow step;
     processes the full crashes parquet; expect ~2-5 min)
   - `njdot gen_county_outlines` (fast; geopandas dissolve)
   - `njdot gen_muni_outlines` (fast; per-county split)
4. `dvx push www/public/njdot/map.dvc` — uploads new bundle to S3.
5. Push the resulting commit (the `.dvc` md5 will have updated).

### Rerun notes (2026-04-25)

- `dvx run www/public/njdot/map.dvc` runs the cmd with cwd =
  `www/public/njdot/`, but the cmd uses project-root-relative paths
  (`njdot/data/crashes.parquet`, `www/public/njdot/map`). Workaround:
  ran the three subcommands manually from the repo root, then
  `dvx add -f www/public/njdot/map` to refresh the .dvc md5
  (preserves `meta.computation`). Same pattern likely affects other
  subdir stages (`crash-log.parquet.dvc`, etc.) — flagged for a
  follow-up; not in this spec's scope.
- `h3` was missing from `pyproject.toml` despite being imported in
  `_emit_hex_aggregates`. Added (`h3>=4.0`); `uv.lock` updated.

## Size impact

Adding PDO to point shards roughly **3×s** the row count of
`by-year/{year}.parquet` and `by-year-county/{year}-{cc}.parquet`
files.

Actual rerun (2026-04-25):
- Before: ~70 MB (`51232694…`, 69,522,796 B)
- After: **~241 MB** (`5200239a…`, 252,799,663 B) — well above the
  pre-rerun 110-130 MB estimate. The 3× point multiplier was correct,
  but the pre-existing `route`/`mp`/`sri` columns plus the new
  `road`/`cross_street` strings carry meaningful size at 4M point
  rows (~3.6× total bundle vs ~3× row count).

Hex aggregates are unchanged in row count (PDO was already in `-H`).
Adding `top_route` is a small string column with ~200 distinct values,
dictionary-encoded — single-digit MB at most. Final breakdown:
`by-year` 116 MB, `by-year-county` 120 MB, hex aggregates ~5 MB,
counties+munis ~2 MB.

## Verification post-rerun

- `dvx status` clean.
- Open `/c/hudson/jersey-city#map`, switch to Hexbin mode, toggle
  Other (PDO) — should show yellow segments populating taller bars.
- Hover any hex with crashes — TT should show "near US 1&9" or similar.
- Manifest: `point_severities: ["f","i","p"]` (was `["f","i"]`).

## Non-goals (deferred)

- Finer hex resolutions (r9, r10) for tight muni framing. The
  client-side `binIntoHexes` (detail-mode) already handles arbitrary
  resolution via the slider, so this only matters if/when we move
  county/muni hexbin to server-side aggregates.
- Cross-street ("X & Y") info. Requires reverse-geocoding or an OSM
  intersections dataset; out of scope.
- PDO at "detail" scale where the user really wants per-crash points
  (vs. binned). The frontend now allows toggling PDO; deck.gl will
  render PDO points like the others. We may want to rate-limit them
  (sample 1/4) to keep the canvas readable.
