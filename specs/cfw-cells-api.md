# CFW + R2: dynamic-resolution H3 cell aggregation API (#52)

## Goal

Replace the static-prebin ladder (`v2/hex-r6.parquet` … `v2/hex_r9/{shard}.parquet`) and the hard zoom-threshold jump to raw-points with a **single dynamic-resolution endpoint**. Sourced from one canonical fine-resolution H3 index, plus a derived rollup-pyramid layer for fast common-case queries. Eliminates chunky-zoom transitions intrinsically (the server returns whatever resolution the picker asks for) and sets us up to expose this as a civic-data API others can use.

## Non-goals

- Replacing NJSP plots (`FatalitiesPerYearPlot`, etc.) — they read CSV, not the cell API.
- Replacing the static county/muni outline GeoJSON files — separate concern.
- Pretty URLs / pagination / server-rendered HTML — JSON API only.
- Auth / rate-limiting beyond Cloudflare's defaults.

## Architecture

```
                   raw NJDOT data (on `e`)
                            │
                            ▼ pipeline (njdot compute)
                  crashes.parquet  + h3 tagging
                            │
                            ├──► raw layer: crashes_h3.parquet (sharded by r4 parent)
                            │       cols: existing crashes columns + h3_r{base}
                            │       sort: by h3_r{base} within each shard
                            │
                            └──► pyramid layer: pyramids/r{N}/(shard).parquet (N ∈ 6..base-1)
                                    cols: h3_r{N}, year, n_fatal, n_inj_*, n_pdo,
                                          n_victims_by_type_severity, n_vehs_*, topK
                                    one row per (h3_r{N}, year)
                            │
                            ▼ dvx push
                            R2 bucket: `crashes-cells`
                            │
                            ▼ HTTP range fetches
                            CFW worker (`crashes-cells-api`)
                            │
                            ▼ JSON
                            client (CrashMapSection / CrashMap)
```

Two layers, both derived from `crashes.parquet`. Either alone works; we want both.

## Layer A — raw (one row per crash, h3-tagged)

- Source: `crashes.parquet` (existing canonical NJDOT crashes).
- Add: a single `h3_r{base}` column — the H3 cell containing each crash's `(lat, lon)` at the configured base resolution.
- **`base` is a config parameter** (default `r13`, ≈3.6m edge — finer than NJDOT GPS noise but coarse enough not to bloat 4× over r12). Pipeline regenerates if changed.
- Sort: rows sorted by `h3_r{base}` within each shard (so parquet RG min/max stats give tree-structured pruning at every coarser N — see "H3 prefix pruning" below).
- Shard: by an `h3_r4` parent. NJ has ~10–15 r4 cells; each shard ends up ~5–10 MB raw, ~1–2 MB compressed. Storage path: `raw/h3_r{base}/{shard_cell}.parquet`.
- Schema: existing crashes columns (cc, mc, severity, dt, tk, ti, pk, pi, tv, sri, mp, road, …) + `h3_r{base}`. Total ~800k rows.
- `cc`/`mc` stay on the raw layer (provenance, joinable to V/D/O/P, official attribution). The pyramid layer doesn't carry them — geo queries become "h3 covering of polygon" instead.

### H3 prefix pruning (why sorting is enough)

H3 cell IDs aren't textual prefixes of their parents (resolution bits sit at fixed high-bit positions, unused digits are padded with `7` on the right), but for a uniform-resolution dataset (all r{base}), sorting numerically sorts by `(base_cell_id, digit_1, …, digit_{base})`. The children of any r{N} ancestor (N < base) share `(base_cell, digit_1, …, digit_N)` and therefore form a **contiguous numerical range** in the sort.

Worker query path:

1. Receive bbox + target res N.
2. Compute h3 covering of bbox at res N (set of r{N} cells).
3. For each r{N} cell `C` in the covering, compute `[min_r{base}_descendant(C), max_r{base}_descendant(C)]` — cheap bit manipulation: `C`'s bits with remaining digits = 0 (min) or 7 (max), resolution bits set to `base`.
4. Pass as an OR'd parquet filter `h3_r{base} BETWEEN min_i AND max_i`. Parquet skips row groups whose RG min/max don't intersect any range.

This is enough pruning that we don't need to store `h3_r0..h3_r{base-1}` columns. Raw layer stays one h3 column wide.

## Layer B — pyramids (per-resolution rollups)

For each query-target resolution `N ∈ {6, 7, 8, …, base-1}`, a small derived table:

```
schema: (h3_r{N}, year, n_fatal, n_inj_ped, n_inj_other, n_pdo,
         n_victims_by_(type, severity)... , n_vehs_by_severity..., topK_recent)
```

- One row per `(h3_r{N}, year)` cell-year. Built by groupby on the raw layer.
- Same shard layout as raw (by r4 parent).
- All sum columns are obvious monoids (associative, identity = 0). topK is a monoid via pair-merge of sorted lists capped at K = 10 (associative; identity = empty list). topK row contents: K `(year, dt, case_pk, severity)` tuples — enough for hover/drill-down without joining back to raw.

### Storage estimate

- r6: ~1k cells × 23 years × ~80 B = ~2 MB
- r9: ~30k × 23 × 80 = ~55 MB across NJ; per-shard ~5 MB
- r12: ~300k × 23 × 80 = ~550 MB; per-shard ~50 MB

r12 pyramids are uncomfortably big per-shard. Two outs:
- Skip r12, only build r6..r11; worker computes r12 by groupby on raw within the bbox (fine — at r12 resolution the bbox is small, raw scan is cheap).
- Keep r12 pyramids but shard them at r5 instead of r4 (~150 shards instead of ~15) so per-shard size drops to ~3 MB.

Default: build pyramids for `{6, 7, 8, 9, 10, 11}`; **skip r12** and use raw groupby. Picker zoom thresholds will mostly land between 7 and 11 anyway.

## Worker API

### Endpoint

```
GET /api/cells
  ?bbox=w,s,e,n        # required, comma-delimited floats
  &res=N               # required, integer in [4, base]
  &years=y0-y1         # optional, default = full range
  &severities=fip      # optional subset of {f,i,p}, default = all
```

Optional later:
- `&fields=...` — projection (default: count fields only; opt-in topK)
- `&format=cbor` — compact binary instead of JSON

### Logic

```pseudo
parse(req); validate(bbox in NJ; res in [4..base]; year_range in [2001..2024])
covering = h3.polygonToCells(bbox, res)
if res < base and pyramid_exists(res):
    shards = r4_cells_intersecting(bbox)
    rows = await Promise.all(shards.map(s => fetch_pyramid(res, s)))
    rows = filter(rows, h3_r{N} ∈ covering, year ∈ year_range, severities)
    cells = groupby(rows, h3_r{N}).sum()
else:
    # raw fallback: high-res or topK
    shards = r4_cells_intersecting(bbox)
    rows = await Promise.all(shards.map(s => fetch_raw(s, h3_range_filters(covering, base))))
    cells = aggregate(rows, h3_r{N} via cellToParent, year_range, severities)
return cells, ETag = hash(req_params + data_version)
```

- **Caching**: Cloudflare edge cache keyed by ETag (which incorporates `data_version` from the dvx pointer). Cache lifetime = 1 hour for unconditional, 24 hours for conditional `If-None-Match` revalidation. Pipeline pushes new data → bumps `data_version` → invalidates.
- **Response shape**: JSON `{cells: [{h3, n_fatal, n_inj, n_pdo, year, ...}, ...], res, year_range}`. Compress with brotli at edge. Target: <500 KB for typical county-zoom queries; <50 KB for state-zoom.

### Error budget

- 4xx: malformed bbox, out-of-range res, bbox outside NJ.
- 5xx: R2 fetch failure, parquet parse failure. Worker retries once before failing.
- Soft fallback: if the pyramid for the requested res is missing, transparently fall through to raw + groupby. Log + alert.

### Local dev

- `wrangler dev` against a local fixture: one `r4` shard worth of NJ (e.g. JC area) extracted from the full data into `local-fixtures/`. Worker reads from a local R2 emulator (miniflare) for tests.
- Unit tests: same fixture, run with vitest.

## Client refactor

Replace `pickFetchPlanV2` + `loadManifestV2` + `shardUrlV2` with a single hook:

```ts
useCellsApi({
  bbox, viewport_lat, zoom, hexPxTarget,
  yearRange, severities,
}): { cells: HexRow[], res: number, status, error }
```

Internally:

```ts
const res = pickResForPixels(hexPxTarget, zoom, lat)
const url = `${API_BASE}/api/cells?bbox=${bbox.join(",")}&res=${res}&years=${y0}-${y1}&severities=${severitiesToString(severities)}`
const data = useFetch(url, { staleWhileRevalidate: true })
```

- `pickResForPixels` no longer snaps to {6,7,8,9}; it picks any integer in `[4, base]`.
- No more "points × N shards" plan branch — the API can serve raw rows via `?res=base` or a future `/api/raw` endpoint if we want pickability.
- `?debug=1` URL param for query inspection (drawer's "plan" line shows `res=N` + `cells.length` + `bytes` + `cache: HIT/MISS`).

### Migration plan

1. Worker + raw layer + r6..r9 pyramids ship first → identical behavior to today's static prebins, but routed through the API.
2. Confirm parity with v2 client (fallback to v2 if `?api=0`).
3. Add r10/r11 pyramids → chunky zone disappears.
4. Drop v2 client + manifest + static prebin files.

## Where the work happens

| Component | Where | Status |
|---|---|---|
| Worker (TypeScript, wrangler) | this session, locally | new |
| Storage layout decisions | this session (in-spec) | drafted in this doc |
| Local fixtures (one r4 shard) | this session, exported from `e` once | TBD |
| R2 bucket + DNS | user clicks once in CF dashboard | spec'd below |
| Pipeline: tag crashes with h3_r{base}, sort+shard, build pyramids, push to R2 | `e` (separate spec) | hand-off as `~/c/hccs/crashes/specs/cfw-cells-pipeline.md` once this spec is approved |
| Client refactor (replace `pickFetchPlanV2`) | this session | after worker has a stable API |

### R2 bucket setup (user, one-time)

1. Cloudflare dashboard → R2 → Create bucket: `crashes-cells`
2. Settings → Public access → Connect custom domain: `cells.crashes.hudcostreets.org` (or similar; current `crashes.hudcostreets.org` is the CF Pages site, so pick a subdomain).
3. Create an R2 API token (read+write) for the dvx pipeline + a read-only token for the worker.
4. Drop `r2 = ...` config into `wrangler.toml` (this session, after bucket exists).

## Open questions / things to revisit during implementation

- **base = r13**: spec'd for now; pipeline takes a flag, can regen at r12 or r14 if r13 turns out poorly chosen.
- **topK K value**: defaulting to 10. Storage cost is bounded; can tune by use case.
- **CFW vs. Ducklings (DuckDB-WASM)**: spec'd for plain CFW + parquet via hyparquet (the worker imports the same library the client uses today). Ducklings is appealing for ad-hoc analytics but adds bundle weight and complexity; can swap in later if query patterns get fancier.
- **API versioning**: prefix `/v1/cells` from day one.
- **Auth / rate-limiting**: rely on Cloudflare WAF defaults until we see abuse. The data is public anyway.
- **Civic-data CDN-friendliness**: R2 bucket mounted as a static parquet store too? I.e. publish the raw + pyramid parquet files at `https://cells.crashes.hudcostreets.org/raw/...` so external tools can DuckDB them directly without going through our worker. Costs ~nothing extra; aligns with the open-data goal.

## Phasing

1. **Spec approval + R2 bucket creation** (now).
2. **Pipeline spec for `e`** (immediately after approval): tag crashes with `h3_r{base}`, sort+shard, build pyramids, push to R2 via dvx. Output: `crashes-cells` bucket populated with raw + pyramids for r6..r11.
3. **Worker scaffold** (this session, in parallel with pipeline): wrangler config, basic routing, fixture-based dev, parquet read via hyparquet, h3 covering + range computation, response serialization.
4. **Worker integration tests** against fixtures.
5. **Client refactor** (this session): introduce `useCellsApi`, gate behind `?api=1` for parity testing.
6. **Cutover**: flip default to API; v2 manifest + static prebin paths deprecated, then deleted.
7. **Cleanup**: delete `pickFetchPlanV2`, `useCrashData` v2 paths, manifest fetcher, static prebin DVC stages.
