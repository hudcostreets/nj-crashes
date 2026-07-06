# Multiplex hex-sld into cells-api response

Kill the 15.1 MB unconditional `hex-sld.parquet` fetch on every map page
load. Merge its 4 tooltip-relevant columns (`sld_name`,
`cross_sld_name`, `mun`, `county`) into the per-cell rows that
cells-api already returns for the viewport.

## Motivation

`www/public/njdot/map/v2/hex-sld.parquet` is 15.1 MB, 723,681 rows,
10 cols. Only `sld_name`, `cross_sld_name`, `mun`, `county` are
consumed (by `CrashTooltip` in `www/src/map/CrashMap.tsx:989-1000`).
The file is fetched at `CrashMap` mount via `useHexSld()` regardless
of whether the user ever hovers a hex.

Row breakdown (2026-07):

| Res | Rows | % of total |
|-----|------|-----------|
| r6  |   1,508 |  0.2% |
| r7  |   5,850 |  0.8% |
| r8  |  23,329 |  3.2% |
| r9  |  79,539 | 11.0% |
| r10 | 207,588 | 28.7% |
| r11 | 405,867 | 56.1% |

Compressed byte cost by column (SNAPPY):

| Column | Bytes | Used in tooltip? |
|--------|-------|------------------|
| h3             | 4.83 MB | (key, needed for join) |
| sri            | 2.32 MB | no |
| sld_name       | 1.86 MB | **yes** |
| cross_sri      | 1.75 MB | no |
| cross_sld_name | 1.49 MB | **yes** |
| mp             | 1.08 MB | no |
| cross_mp       | 0.78 MB | no |
| mun            | 0.53 MB | **yes** |
| route_subt     | 0.26 MB | no |
| county         | 0.20 MB | **yes** |

## Design

cells-api already returns a `CellOut[]` per viewport request. Each row
is one h3 cell at the response resolution, with counts. Extend that
row shape with 4 optional string fields, sourced from a parallel R2
shard read + in-worker hash-join by h3.

### R2 layout

New pyramid `pyramid_sld/`, mirroring the counts pyramid layout:

```
pyramid_sld/s{shard_res}_r{data_res}/{shard_cell}.parquet
```

Same `(shard_res, data_res)` combos as `manifest.pyramid_combos`.
Cols per row (zstd, one row-group):

```
h3: BYTE_ARRAY (UTF8)                       # cell id at data_res
sld_name: BYTE_ARRAY (UTF8)
cross_sld_name: BYTE_ARRAY (UTF8), nullable
mun: BYTE_ARRAY (UTF8)
county: BYTE_ARRAY (UTF8)
```

### Wire types

Extend `CellOut` in `cells-api/src/cells.ts`:

```ts
export type CellOut = {
    h3: string
    n_fatal: number
    n_inj_ped: number
    n_inj_other: number
    n_pdo: number
    n_vehs: number
    fatal_years?: number[]

    // NEW — populated by pyramid_sld join. Optional so scopes that
    // fail the join (missing sld shard, ocean cells) stay valid.
    sld_name?: string
    cross_sld_name?: string
    mun?: string
    county?: string
}
```

Every cells-api response now carries the tooltip payload inline. No
new URL, no new endpoint, no extra RTT.

### Worker changes (`cells-api/src/cells.ts`)

In both `queryPyramid` and `queryRaw`, after building the `CellOut`
map, do a parallel-per-shard sld read:

```ts
// After counts join, run per-shard sld read in parallel.
const sldResults = await Promise.all(shards.map(async s => {
    try {
        return await readParquetFromR2<SldRow>(
            bucket,
            `${prefix}/pyramid_sld/${subdir}/${s}.parquet`,
            { columns: ["h3", "sld_name", "cross_sld_name", "mun", "county"] },
        )
    } catch (e) {
        // Missing sld shard is non-fatal — tooltip degrades to no
        // road/muni label. Log once, skip.
        console.warn(`pyramid_sld ${subdir}/${s} read failed:`, e)
        return null
    }
}))
for (const rows of sldResults) {
    if (!rows) continue
    for (const r of rows) {
        const cell = out.get(r.h3)
        if (!cell) continue  // sld row for a cell we filtered out — skip
        if (r.sld_name) cell.sld_name = r.sld_name
        if (r.cross_sld_name) cell.cross_sld_name = r.cross_sld_name
        if (r.mun) cell.mun = r.mun
        if (r.county) cell.county = r.county
    }
}
```

Notes:
- Same `subdir` (`s{shard_res}_r{data_res}` or `r{res}`) — sld shards
  live under a parallel prefix.
- Each shard's counts + sld reads happen concurrently (already inside
  `Promise.all` — worker just adds a second batch of R2 reads).
- Missing shard is soft-fail; user sees a tooltip without the road
  name but the map still works.

Extra R2 reads = number of shards in the request (typically 1-25).
Same R2 bucket, same region, in parallel with the existing reads →
~10-30 ms overhead on the 200-500 ms baseline.

Extra JSON payload: ~40 bytes/row × N cells. For 1000 cells:
+40 KB uncompressed, +10-15 KB gzipped. Noise vs the 15 MB baseline.

### Client changes

- **Delete**: `www/src/map/useHexSld.ts` and the fetch it drives.
- **Delete**: `www/public/njdot/map/v2/hex-sld.parquet` (once R2 is
  live — leave the file around briefly for rollback).
- **Update**: `www/src/map/CrashMap.tsx`
  - Drop `import { useHexSld, type HexSldLookup } from "./useHexSld"`.
  - Drop the `const sldMap = useHexSld()` call.
  - Drop `sldMap` prop threading into `CrashTooltip`.
  - `CrashTooltip` reads `hex.sld_name`, `hex.cross_sld_name`,
    `hex.mun`, `hex.county` directly off the `StackedHex` object.
  - Update `useCellsApi` to preserve the new fields when mapping
    `CellOut → StackedHex`.
- **Update**: `www/src/map/StackedHexLayer.tsx` — extend `StackedHex`
  type with the 4 optional string fields.
- **Update**: `www/src/map/useCellsApi.ts` — propagate the new fields
  through the cell-to-StackedHex mapping.

Client-side binning path (`binIntoHexes` in `StackedHexLayer.tsx`,
used when `prebinnedHexes` is absent) does *not* get sld fields
populated — that path was rare and only fired for raw scatter data.
Tooltip degrades to no label; acceptable.

### Pipeline change — reuse existing `hex-sld.parquet`

Rather than rebuild from scratch, **derive the sharded output from
the already-fresh `hex-sld.parquet`**. It's built by
`njdot export_hex_sld` as part of `www/public/njdot/map.dvc`, so it's
refreshed whenever crash data changes — the KDTree + PIP work already
happened.

New subcommand: `njdot reshard_hex_sld` (this session, already
written).

```bash
njdot reshard_hex_sld \
    -s www/public/njdot/map/v2/hex-sld.parquet \
    -m data/cells/manifest.json \
    -o data/cells/pyramid_sld
```

Steps:

1. Load `hex-sld.parquet` (r6-r11 cells with sld/mun/county).
2. Read `data/cells/manifest.json` → enumerate `pyramid_combos`.
3. For each combo `(shard_res, data_res)`, for each shard listed,
   read the peer counts-pyramid shard's h3 column
   (`data/cells/pyramid/s{shard_res}_r{data_res}/{shard}.parquet`) to
   get the exact cell set at that (combo, shard).
4. For each cell: if `data_res <= 11`, look up sld directly; else
   walk up to the r11 parent (same fallback as legacy
   `useHexSld.lookup`).
5. Emit `pyramid_sld/s{shard_res}_r{data_res}/{shard}.parquet` with
   cols `[h3, sld_name, cross_sld_name, mun, county]`, zstd, one
   row group.

Runtime: ~10 min on a laptop (single-threaded pandas). Cheap because
KDTree/PIP is already done; this is pure enumeration + parent walk +
parquet write.

Local test result (2026-07-06):
- Total: 1.2 GB across 23 combos, ~200k shards
- Typical per-shard: 5-20 KB
- All combos emit within ~3% shard-count of counts-pyramid
  (soft-miss on cells present in counts but absent in the r6-r11
  sidecar — silent pass-through, tooltip degrades).

### DVX / DVC wiring

- `data/cells/pyramid_sld.dvc` (new) — deps: `www/public/njdot/map/v2/hex-sld.parquet`
  + `data/cells/manifest.json` + shard shells from
  `data/cells/pyramid/`. Cmd: `cd ../.. && njdot reshard_hex_sld -f`.
  Runs after `data/cells/pyramid.dvc` (needs the counts pyramid to
  know which cells to shard for).
- R2 upload: existing `njdot compute cells push` already syncs
  `data/cells/` → `s3://nj-crashes/cells/` with `aws s3 sync --delete`.
  The new `pyramid_sld/` subdir gets synced automatically — no code
  change to `cells.py:cells_push`.
- Old `www/public/njdot/map/v2/hex-sld.parquet` gets deleted once
  multiplex is verified in prod (follow-up commit).
  `njdot/cli/export_hex_sld.py` stays — the reshard depends on its
  output.

## Rollout plan

### Session A (this session — laptop)

1. Land the spec (this file).
2. Land code changes:
   - `cells-api/src/cells.ts` — add fields to `CellOut`, sld join in
     `queryPyramid` + `queryRaw`.
   - `www/src/map/StackedHexLayer.tsx` — add fields to `StackedHex`.
   - `www/src/map/useCellsApi.ts` — propagate fields.
   - `www/src/map/CrashMap.tsx` — read fields off `hex` in tooltip,
     drop `sldMap` prop threading.
   - Delete `www/src/map/useHexSld.ts` (import site cleanup).
   - `njdot/cli/export_hex_sld_pyramid.py` — new sharded emitter.
3. Local test: derive sharded parquets from the current
   `hex-sld.parquet` (via `cell_to_parent` group-by) to validate the
   worker+client end-to-end without re-running KDTree/PIP. Serve
   locally via `wrangler dev` if easy; else stub.
4. Commit + push (WWW commit gated on worker deploy landing first
   in Session B).

### Session B (`e`)

Everything is code-in-place after Session A. Session B is just:

1. Pull latest `main`.
2. Verify `www/public/njdot/map/v2/hex-sld.parquet` is present + fresh
   (`dvx status` on `www/public/njdot/map.dvc` — if stale, `dvx run`).
3. Verify `data/cells/pyramid/` is present + fresh (`dvx status` on
   `data/cells/pyramid.dvc`).
4. Run `njdot reshard_hex_sld` → produces `data/cells/pyramid_sld/`
   locally (~10 min).
5. `njdot compute cells push` → mirrors `data/cells/` (both `pyramid/`
   and `pyramid_sld/`) to `s3://nj-crashes/cells/` via `aws s3 sync`.
6. `cd cells-api && pnpm wrangler deploy` — the join code is already
   on `main`; deploy activates it.
7. Verify: curl the cells-api with a viewport bbox; response should
   include `sld_name`/`mun`/`county` on returned cells.
8. Verify Network tab in-browser: `hex-sld.parquet` request is gone;
   cells-api responses include the extra fields.
9. Follow-up commit (either session): delete
   `www/public/njdot/map/v2/hex-sld.parquet` (rebuilt but no longer
   consumed — mark `export_hex_sld` output as intermediate). Or leave
   it; costs nothing to keep the source parquet on disk.

Add `data/cells/pyramid_sld.dvc` at some point — cleanest is Session A
after the reshard proves out, but it's a mechanical `dvx add` and can
happen either session.

## Non-goals

- Not touching the counts pyramid (`pyramid/`) — sld is a strict
  sidecar, joined at response time, no schema change to counts.
- Not adding a new HTTP endpoint. Payload rides existing
  `/v1/cells` responses.
- Not deleting `hex-sld.parquet` immediately — leave briefly for
  rollback until multiplex is confirmed working in prod.

## Rollback

If the worker join misbehaves in prod:
- Revert the cells-api worker deploy (previous version doesn't do
  the join). Client still reads the new optional fields; they'll
  just be `undefined` → tooltip has no road label. No page break.
- Client can be reverted independently to restore the 15 MB
  fetch path if the tooltip label absence is user-visible enough
  to matter during the incident window.

## Follow-ups (not blocking)

- `useHexSld` deferred-load pattern (the "1" from the design chat)
  — no longer needed once multiplex lands. Skip.
- If scatter mode tooltips need labels, consider a small
  `hex-sld-r6-r9.parquet` (~1 MB pruned+zstd) for that path only.
