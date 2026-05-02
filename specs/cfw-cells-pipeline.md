# Cells API pipeline (#52, `e` task)

## Context

Companion to `specs/cfw-cells-api.md` (the API + worker design). This spec covers the **data pipeline**: tag crashes with H3 cell IDs, sort + shard, build the pyramid rollups, push to R2. Runs on `e` (the raw NJDOT data lives there; this is big-DataFrame work).

Read `specs/cfw-cells-api.md` first for architecture context (raw layer + pyramid layer, shard scheme, query patterns).

## Inputs

- `njdot/data/crashes.parquet` (canonical NJDOT crashes, DVC-tracked).
- Config (top of pipeline script):
  - `BASE_RES = 14` (configurable; r12–r15 all valid)
  - `SHARD_RES = 4` (one file per r4 parent — ≈10–15 shards covering NJ)
  - `PYRAMID_LEVELS = [6, 7, 8, 9, 10, 11]` (skip r12; worker handles r12+ via raw groupby)
  - `TOPK = 10` (most-recent crashes per pyramid cell, stored as a list)
- R2 credentials. The `cf` AWS profile already configured locally on `e` should work for S3-compatible writes (endpoint `https://0dcad5654e9744de6616f74b8df4af63.r2.cloudflarestorage.com`, region `auto`); alternatively a Cloudflare API token with `Workers R2 Storage: Edit`.
- Bucket: **`nj-crashes`** (project-wide, already created on R2). All cells artifacts live under the **`cells/`** prefix; future migrated S3 data shares the bucket at sibling prefixes (e.g. `parquets/`, `csvs/`).

## Outputs

R2 bucket layout (project-scoped under `cells/`):

```
nj-crashes/
  cells/
    manifest.json                     # data version + bucket layout, read by worker on cold start
    raw/h3_r14/
      {r4_cell_id}.parquet            # 10–15 files, ~5 MB each
    pyramid/r6/{r4_cell_id}.parquet   # tiny
    pyramid/r7/...
    pyramid/r8/...
    pyramid/r9/...
    pyramid/r10/...
    pyramid/r11/...
```

`{r4_cell_id}` = the H3 cell ID at resolution 4 (rendered as 13-hex-digit string, e.g. `841f97ffffffff`).

## Phase 1 — raw layer

```
Input:  njdot/data/crashes.parquet  (6.57M rows, existing schema)
Output: data/cells/raw/h3_r14/*.parquet
```

**Status:** done 2026-05-02. 6.57M crashes → 3.98M with lat/lon (60%; 39.4% are ungeocoded) → **31 r4 shards, 70 MB compressed total**. Tracked at `data/cells/raw/h3_r14.dvc`; mirrored to `s3://nj-crashes/cells/`.

### Steps

1. Load `crashes.parquet`.
2. Drop rows with null `lat`/`lon` (ungeocoded). Track count for telemetry. *No* geocoding fallbacks here — the cells API serves crashes that have a known location; ungeocoded crashes remain available via the existing `crashes.parquet` for legacy/aggregate plots.
3. Compute `h3_r14 = latLngToCell(lat, lon, 14)` per row. (Use `h3` Python package: `pip install h3>=4.0`.)
4. Compute `shard_cell = cellToParent(h3_r14, 4)`.
5. Sort the full table by `(shard_cell, h3_r14)`.
6. Partition + write: one parquet file per `shard_cell`, named `{shard_cell}.parquet`. Each shard's rows are pre-sorted by `h3_r14`.
7. Set parquet write options: `row_group_size=20_000`, `compression='zstd'`, `write_statistics=True`. Row group statistics on `h3_r14` give the worker tree-structured pruning at any coarser N (see API spec).

### Schema (Phase 1)

Reuses `_build_base()` from `njdot/cli/export_map_data.py` (effective `lat`/`lon` synth from `ilat`/`ilon` → `olat`/`olon` fallback, type-narrowing, dt → epoch minutes), then adds `year` (re-attached from source) + `h3_r14`. Columns the worker doesn't immediately need are kept — projection happens at fetch time via hyparquet column projection.

Resulting schema (20 cols):

| col | type | notes |
|---|---|---|
| year | int16 | row-group-stats prune by year |
| cc | int8 | provenance (joinable to V/D/O/P) |
| mc | int16 | provenance |
| case | string | crash PK |
| dt | int32 | epoch minutes (matches `_build_base`) |
| lat | float32 | effective (interpolated → original fallback, NJ-bbox-validated) |
| lon | float32 | effective |
| geocode_src | string | `'interpolated'` / `'original'` provenance flag |
| severity | string | `f`/`i`/`p` |
| tk, ti, pk, pi, tv | int16 | killed/injured tier counts (matches `_build_base` types) |
| sri, mp, road, cross_street, route | string | route info, optional |
| **h3_r14** | **int64** | **new — uint64 reinterpret (high bit of H3 cell IDs is reserved/0)** |

### Storage (actuals, 2026-05-02)

- 3.98M rows × 18 bytes/row median compressed = ~70 MB total
- 31 shards, distribution heavily right-skewed: 3 shards ≥6 MB (Hudson/Essex/Bergen), median ~250 KB, ~10 micro-shards <20 KB (NJ border strays)
- Worker fetches only intersecting shards, so micro-shards cost ~nothing at query time

## Phase 2 — pyramid layer

```
Input:  data/cells/raw/h3_r14/*.parquet
Output: data/cells/pyramid/r{N}/*.parquet  for N in PYRAMID_LEVELS
```

### Steps

For each `N` in `PYRAMID_LEVELS`:

1. Load all raw shards (or stream per-shard to keep memory bounded).
2. Compute `h3_rN = cellToParent(h3_r14, N)`.
3. Compute pyramid `shard_cell = cellToParent(h3_rN, 4)`.
4. Group by `(shard_cell, h3_rN, year)` and aggregate (see schema below).
5. Sort by `(shard_cell, h3_rN, year)`.
6. Write one parquet per `shard_cell` to `data/cells/pyramid/r{N}/{shard_cell}.parquet`. Same parquet write options as raw (zstd, row groups, stats).

### Schema (Phase 2)

Per pyramid level:

| col | type | notes |
|---|---|---|
| h3_rN | uint64 | the cell at this level |
| year | int16 | per-year breakdown |
| n_fatal | uint16 | sum |
| n_inj_ped | uint16 | sum (uses crash-level `pi` count) |
| n_inj_other | uint16 | sum (`ti - pi`) |
| n_pdo | uint16 | sum (severity = 'p') |
| n_killed_drv | uint16 | sum |
| n_killed_pass | uint16 | sum |
| n_killed_ped | uint16 | sum from `pk` |
| n_inj_drv | uint16 | sum |
| n_inj_pass | uint16 | sum |
| n_vehs | uint16 | sum |
| topK | list<struct{year:int16, dt:int64, case:string, severity:string}> | top 10 most recent crashes in this cell-year, by `dt` desc; pair-merge on rollup |

`topK` storage: ~10 entries × ~30 bytes = ~300 bytes/row. Modest. Use parquet `LIST<STRUCT>` encoding.

For the more granular victim/vehicle counts: pull them out of the existing crashes table (or join V/D/O/P), aggregate. If the join is heavy, defer to a v2 of the pyramid — start with `n_fatal/n_inj_ped/n_inj_other/n_pdo/n_vehs` and `topK`, add the type-severity matrix later.

### Storage estimate

- r6: ~70 cells × 23 years × ~150 B ≈ 250 KB total
- r9: ~30k × 23 × 150 ≈ 100 MB → ~20 MB compressed; per-shard ~2 MB
- r11: ~150k × 23 × 150 ≈ 500 MB → ~100 MB compressed; per-shard ~10 MB

r11 per-shard is ~10 MB, on the edge of "is this worth pre-computing vs. raw groupby?" Acceptable for now; can drop later if cold-cache traffic is low.

## Phase 3 — manifest

`manifest.json` at bucket root, regenerated whenever phases 1 or 2 run:

```json
{
  "schema_version": 3,
  "data_version": "2026-05-01T22:00:00Z-<sha>",
  "base_res": 14,
  "shard_res": 4,
  "pyramid_levels": [6, 7, 8, 9, 10, 11],
  "year_range": [2001, 2023],
  "shard_cells": ["841f97ffffffff", "841f8bffffffff", ...],
  "row_counts": {
    "raw": 798421,
    "pyramid_r6": 1547,
    ...
  }
}
```

`data_version` is content-addressed — used as cache key in the worker. Bumps on every successful pipeline run.

## R2 push (DVX + flat mirror)

DVX's content-addressed cache layout (`s3://nj-crashes/.dvc/files/md5/...`) is the right mechanism for *provenance and IDPy*, but the worker reads parquet by **human-readable URLs** (`s3://nj-crashes/cells/raw/h3_r14/{shard}.parquet`). So the pipeline does both:

1. **`dvx push <.dvc>`** — pushes content-addressed blobs to the existing `s3` remote (`s3://nj-crashes/.dvc`). Used for provenance and `dvx pull` recoverability.
2. **`njdot compute cells push`** — `aws s3 sync data/cells/ s3://nj-crashes/cells/ --exclude '*.dvc' --exclude '.gitignore' --delete` via the `cf` AWS profile. Worker-readable mirror.

Each phase is wrapped as a `.dvc` stage. **The .dvc lives next to its data** (matching the existing `data/*.dvc` and `www/public/njdot/map.dvc` conventions), not under `njdot/data/`:

```yaml
# data/cells/raw/h3_r14.dvc — Phase 1 output
outs:
  - md5: <dir-md5>.dir
    path: h3_r14
meta:
  computation:
    cmd: cd ../../.. && njdot compute cells raw -f
    deps:
      /njdot/data/crashes.parquet: <md5>
```

```yaml
# data/cells/pyramid.dvc — Phase 2 output (TBD)
outs:
  - md5: <dir-md5>.dir
    path: pyramid
meta:
  computation:
    cmd: cd ../.. && njdot compute cells pyramid --levels 6,7,8,9,10,11
    deps:
      /data/cells/raw/h3_r14: <dir-md5>.dir
```

Re-run is idempotent — DVX skips if hashes match; `aws s3 sync --delete` is byte-identical-skip.

## Daily integration

Once the cells API is the default (post-cutover, see API spec), add `cells_raw.dvc` + `cells_pyramid.dvc` to the daily.yml pipeline (between `harmonize.dvc` and `csvs.dvc`). NJDOT data only updates annually so phase 1 will be a no-op most days; phase 2 becomes a tiny re-aggregation if anything in raw changes.

Until cutover, keep this as a **manual** stage you trigger when data updates.

## Implementation notes

### CLI

Lives at `njdot/cli/cells.py`, registered via `njdot/cli/__init__.py` (avoids the circular import that would arise from registering inside `base.py`):

```
njdot compute cells raw [-b/--base-res 14] [-s/--shard-res 4] [-o/--out-dir data/cells] [-f/--force]
njdot compute cells pyramid [-l/--levels 6,7,8,9,10,11]   # Phase 2 (TBD)
njdot compute cells manifest [-b 14] [-s 4] [-l 6,7,8,9,10,11] [-o data/cells]
njdot compute cells push [-b/--bucket nj-crashes] [-p/--prefix cells] [--profile cf] [-n/--dry-run]
```

`push` is `aws s3 sync` (worker-readable mirror), **not** `dvx push` (content-addressed cache). Both are needed; see "R2 push" above.

### h3 Python package

The default `h3` v4 module returns **strings**:

```python
import h3
h3.latlng_to_cell(40.7, -74.0, 14)   # → '8e2a1072d6940cf'  (15-hex string)
h3.cell_to_parent(c_str, 4)           # → '842a107ffffffff'  (string)
h3.str_to_int(c_str)                  # → 640251149238747343
h3.int_to_str(c_int)                  # → '8e2a1072d6940cf'
```

To get ints directly (avoiding string roundtrips), use the `numpy_int` API variant:

```python
from h3.api import numpy_int as h3i
h3i.latlng_to_cell(lat, lon, 14)       # → int64 directly
h3i.cell_to_parent(c_int, 4)           # → int64 directly
```

`latlng_to_cell` is scalar-only (no vectorized variant), but a tight Python loop hits ~565k cells/s — fast enough (~7s for 4M crashes).

**Storage**: `h3_r14` is stored as `int64` per spec — H3 cell IDs fit in int63 (high bit reserved). Sort order on `int64` matches the worker's `BETWEEN min_int AND max_int` filter pushdown.

### Sort + RG stats correctness

After sort, parquet row groups will have monotone `h3_r14` ranges. Verify on a sample shard:

```python
import pyarrow.parquet as pq
f = pq.ParquetFile('data/cells/raw/h3_r14/<shard>.parquet')
for i in range(f.metadata.num_row_groups):
    rg = f.metadata.row_group(i)
    h3_col = rg.column(rg.schema.get_field_index('h3_r14'))
    print(h3_col.statistics.min, h3_col.statistics.max)
```

Adjacent row groups should have non-overlapping (and increasing) `h3_r14` ranges. If they do, the worker's range pushdown will work.

### topK monoid

Pair-merge of two top-K lists (each pre-sorted by `dt` desc):

```python
def merge_topk(a, b, k):
    out = []
    i = j = 0
    while len(out) < k and (i < len(a) or j < len(b)):
        if j >= len(b) or (i < len(a) and a[i].dt > b[j].dt):
            out.append(a[i]); i += 1
        else:
            out.append(b[j]); j += 1
    return out
```

Aggregation produces topK at the cell-year level directly from raw rows (sort by dt desc, take first K). Rollups across cell-years merge two K-lists.

## Test plan

1. **Row-count parity**: raw shards' row count sum = `crashes.parquet` row count − null-geo count.
2. **Pyramid groupby parity**: for each level N, `sum(n_fatal)` across all pyramid rows = total fatal crashes in raw. Same for n_inj_*, n_pdo, etc.
3. **topK correctness**: spot-check a known dense cell (e.g. JC Communipaw) — top-10 most-recent crashes there should match a manual query against raw.
4. **Sort correctness**: per shard, row groups have monotone non-overlapping `h3_r14` ranges (script above).
5. **Round-trip a covering query**: pick a known r6 cell C in JC, compute its r14 descendant range, fetch raw rows in that range, group by `cellToParent(_, 6)` — should match the pyramid r6 row for C.
6. **Manifest validity**: `manifest.json` parses, references shard files that all exist.

## Phasing

1. ✅ **Phase 1 + manifest done 2026-05-02.** Worker can run against this alone (raw groupby for all queries).
2. Implement phase 2 (pyramid r6..r11). Push to R2. Worker switches to pyramid for those levels.
3. Wire into daily.yml (post-cutover).

## Hand-off

Once this spec is implemented and pushed to R2, ping the local session — worker scaffold (in this repo, separate spec `cfw-cells-api.md`) will be ready to point at the live bucket. Until then, the worker dev-tests against `local-fixtures/` (export one shard worth of NJ at the end of phase 1 for that purpose: `njdot compute cells raw --shard-res 4 --only-shard 841f97ffffffff` or similar).
