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
- R2 credentials (token, bucket name `crashes-cells`).

## Outputs

R2 bucket layout:

```
crashes-cells/
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
Input:  njdot/data/crashes.parquet  (~800k rows, existing schema)
Output: data/cells/raw/h3_r14/*.parquet
```

### Steps

1. Load `crashes.parquet`.
2. Drop rows with null `lat`/`lon` (ungeocoded). Track count for telemetry. *No* geocoding fallbacks here — the cells API serves crashes that have a known location; ungeocoded crashes remain available via the existing `crashes.parquet` for legacy/aggregate plots.
3. Compute `h3_r14 = latLngToCell(lat, lon, 14)` per row. (Use `h3` Python package: `pip install h3>=4.0`.)
4. Compute `shard_cell = cellToParent(h3_r14, 4)`.
5. Sort the full table by `(shard_cell, h3_r14)`.
6. Partition + write: one parquet file per `shard_cell`, named `{shard_cell}.parquet`. Each shard's rows are pre-sorted by `h3_r14`.
7. Set parquet write options: `row_group_size=20_000`, `compression='zstd'`, `write_statistics=True`. Row group statistics on `h3_r14` give the worker tree-structured pruning at any coarser N (see API spec).

### Schema (Phase 1)

Existing crashes columns + `h3_r14`. Don't drop columns that the worker might project later — the worker selects columns at fetch time via hyparquet column projection.

| col | type | notes |
|---|---|---|
| year | int16 | row-group-stats prune by year |
| cc | int8 | provenance (joinable to V/D/O/P) |
| mc | int16 | provenance |
| case | string | crash PK |
| dt | int64 | epoch minutes (existing convention) |
| lat | float32 | original |
| lon | float32 | original |
| severity | string | `f`/`i`/`p` |
| tk, ti, pk, pi, tv | int8 | killed/injured tier counts |
| sri, mp, road | string | route info, optional |
| **h3_r14** | **uint64** | **new — `int64` with reinterpret if Arrow doesn't support uint64** |

### Storage estimate

- Raw rows: ~800k × ~80 bytes uncompressed ≈ 65 MB → ~10 MB compressed.
- Per shard: ~50–100k rows × ~100 bytes uncompressed ≈ 5–10 MB → ~1 MB compressed.

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

## R2 push (DVX-style)

Wrap each phase as a `.dvc` stage so it's incremental + content-addressed:

```yaml
# njdot/data/cells_raw.dvc
outs:
  - md5: ...
    path: ../../data/cells/raw/h3_r14/
meta:
  computation:
    cmd: njdot compute cells raw --base-res 14 --shard-res 4
    deps:
      njdot/data/crashes.parquet: <md5>
```

```yaml
# njdot/data/cells_pyramid.dvc
outs:
  - md5: ...
    path: ../../data/cells/pyramid/
meta:
  computation:
    cmd: njdot compute cells pyramid --levels 6,7,8,9,10,11
    deps:
      data/cells/raw/h3_r14/: <md5>
```

Push to R2 via dvx remote (configure once: `dvx remote add cells s3://crashes-cells -c …`). Re-run is idempotent — dvx skips if hashes match.

## Daily integration

Once the cells API is the default (post-cutover, see API spec), add `cells_raw.dvc` + `cells_pyramid.dvc` to the daily.yml pipeline (between `harmonize.dvc` and `csvs.dvc`). NJDOT data only updates annually so phase 1 will be a no-op most days; phase 2 becomes a tiny re-aggregation if anything in raw changes.

Until cutover, keep this as a **manual** stage you trigger when data updates.

## Implementation notes

### CLI

Add to `njdot/cli/`:

```
njdot compute cells raw [--base-res 14] [--shard-res 4]
njdot compute cells pyramid [--levels 6,7,8,9,10,11]
njdot compute cells manifest
njdot compute cells push     # convenience wrapper around `dvx push cells_*`
```

### h3 Python package

```python
import h3
h3.latlng_to_cell(lat, lon, 14)            # → int (uint64)
h3.cell_to_parent(c, 4)                     # → int
h3.h3_to_string(c)                          # → '8e1f97abcdef123' (15-hex)
h3.string_to_h3('...')                      # → int
```

Modern h3 (v4) returns ints by default. If we want hex-string IDs in parquet for human readability, convert at write time; otherwise store int64 (cheaper and what hyparquet expects).

**Recommendation**: store `h3_r14` as `int64` (reinterpret of the uint64 — H3 cell IDs fit in int64 since the high bit is always reserved/0). Keeps parquet types clean and Arrow-compatible.

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

1. Implement phase 1 + manifest. Push to R2. Worker can run against this alone (raw groupby for all queries).
2. Implement phase 2 (pyramid r6..r11). Push to R2. Worker switches to pyramid for those levels.
3. Wire into daily.yml (post-cutover).

## Hand-off

Once this spec is implemented and pushed to R2, ping the local session — worker scaffold (in this repo, separate spec `cfw-cells-api.md`) will be ready to point at the live bucket. Until then, the worker dev-tests against `local-fixtures/` (export one shard worth of NJ at the end of phase 1 for that purpose: `njdot compute cells raw --shard-res 4 --only-shard 841f97ffffffff` or similar).
