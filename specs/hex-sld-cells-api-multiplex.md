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

**Single flat file** at `cells/hex-sld.parquet` (~7 MB zstd,
column-pruned to 5 tooltip cols). The counts pyramid needs sharding
because it has 6-14M rows × years × severity breakdowns (~4 GB); the
sld sidecar is only 723k rows × 4 short string cols — sharding it
would blow up file count without meaningful per-request wins.

Layout:

```
h3: BYTE_ARRAY (UTF8)                       # cell id, r6-r11
sld_name: BYTE_ARRAY (UTF8)
cross_sld_name: BYTE_ARRAY (UTF8), nullable
mun: BYTE_ARRAY (UTF8)
county: BYTE_ARRAY (UTF8)
```

Rows sorted by `h3` so parquet row-group stats (min/max per group)
give hyparquet range-pruning — worker reads only row groups whose h3
range overlaps the query cells. Row group size: 50k rows → 15 groups
for 723k rows.

Worker loads the whole map once per isolate (module-scoped cache);
cells at data_res > 11 walk up to their r11 ancestor via
`cellToParent` (same fallback as the legacy client
`useHexSld.lookup`).

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

Module-scoped cached Map: `sldCached: Promise<Map<h3, SldRow>>` —
first request reads `cells/hex-sld.parquet` (~7 MB), builds the map,
caches for the isolate's lifetime. Subsequent requests do O(1) lookups.

```ts
async function joinSld(bucket, prefix, cells: CellOut[]) {
    const sld = await loadSldMap(bucket, prefix)
    for (const c of cells) {
        const res = getResolution(c.h3)
        const key = res > SLD_MAX_RES ? cellToParent(c.h3, SLD_MAX_RES) : c.h3
        const row = sld.get(key)
        if (!row) continue
        if (row.sld_name) c.sld_name = row.sld_name
        if (row.cross_sld_name) c.cross_sld_name = row.cross_sld_name
        if (row.mun) c.mun = row.mun
        if (row.county) c.county = row.county
    }
}
```

Wired into both request paths (combo path + legacy adaptive-res path),
after cells have been built. Missing sidecar → soft-fail (warn once,
tooltip degrades to no road label). Cached load failure clears
`sldCached` so a subsequent request retries.

Costs:
- Cold-start: one R2 read of ~7 MB, ~200-500 ms parse. Amortized across
  all requests handled by that isolate.
- Warm: O(1) map lookups per cell, ~0 ms.
- Payload delta: +40 bytes/row × N cells. For 1000 cells: +40 KB
  uncompressed / +10-15 KB gzipped. Noise vs 15 MB baseline.

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

### Pipeline change — column-prune the existing `hex-sld.parquet`

`hex-sld.parquet` is built by `njdot export_hex_sld` as part of
`www/public/njdot/map.dvc`, refreshed on every crash-data update.
The reshard subcommand just column-prunes + zstd-compresses +
h3-sorts it:

```bash
njdot reshard_hex_sld \
    -s www/public/njdot/map/v2/hex-sld.parquet \
    -o data/cells/hex-sld.parquet \
    -r 50000
```

Output: `data/cells/hex-sld.parquet` — 5 cols
(`h3, sld_name, cross_sld_name, mun, county`), zstd, h3-sorted, 15
row groups of 50k rows each.

Runtime: seconds (single-file rewrite; no h3 enumeration).

Local result (2026-07-06):
- Source: 15.11 MB (10 cols)
- Output: 6.86 MB (5 cols, zstd, sorted) — 45% of source, 45% of
  original 15 MB unconditional client fetch
- 723,681 rows / 15 row groups. Row-group h3 ranges cleanly split
  by resolution prefix (r6-r8 → rg0; r9 → rg1-2; r10 → rg3-6;
  r11 → rg7-14).

### DVX / DVC wiring

- `data/cells/hex-sld.parquet.dvc` (new) — dep:
  `www/public/njdot/map/v2/hex-sld.parquet`.
  Cmd: `cd ../.. && njdot reshard_hex_sld`.
- R2 upload: `data/cells/hex-sld.parquet` is a single file — either
  `aws s3 cp` it directly or piggyback on `njdot compute cells push`
  (which syncs `data/cells/`).
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
