# Map v2: per-resolution single-file fallbacks

> Status (2026-04-30): backend export + picker logic landed
> (`6155bea2287`), `map.dvc` md5 synced (`335c83cdc9d`),
> verification matrix below complete except for the year-range
> pushdown finding (called out as a follow-up).

## Motivation

The v2 picker (`pickFetchPlanV2`) had a binary fallback: if the
visible viewport intersects more than `maxHexShards` (=30) shards
at the picker's chosen resolution, fall back to the r6 single-file
(`hex-r6.parquet`). r6 cells are 3.2 km wide — at statewide-ish
zooms (z6-z8) the lattice is *visibly chunky* once columns render
at the cell's circumradius (after the `getResolution` clamp in
`CrashMap.tsx`).

Two failure modes the user observed:

1. **Pre-clamp**: render resolution > data resolution → column radius
   smaller than cell hex-tant → grid leaks as visible gaps between
   bars (`?v=40.7207_-74.0614_12.2_6_3` on /map/c/hudson/jersey-city,
   showing skinny columns on r9 lattice).
2. **Post-clamp**: render resolution = data resolution → columns
   fully cover hex-tants → at statewide z6.5 with r6 fallback, each
   cell is ~3 px wide on screen, columns visible as chunky blobs
   (`?llz=40.3720_-74.4208_6.56_37_-15` on the home page hero map).

Goal: the user should never *see* the binning. Map should look
hi-fi at every zoom; binning is an internal performance optimization
to keep MM+ points tractable, not a visible feature.

## Design

### Backend: per-resolution single-file artifacts

`export_map_v2.py` always emits `hex-r{N}.parquet` at the v2 root for
N in {6, 7, 8, 9}, in addition to the sharded `hex-r{N}/{cell}.parquet`
for N in {7, 8, 9}. File-size estimates from local re-run:

| Res | Cell size  | Single-file (raw) | After col-projection + year-pushdown |
|-----|------------|-------------------|----------------------------------------|
| r6  | 3229 m     | ~400 KB           | ~50 KB                                 |
| r7  | 1220 m     | ~1.8 MB           | ~250 KB                                |
| r8  |  461 m     | ~2.8 MB           | ~500 KB                                |
| r9  |  174 m     | ~5.2 MB           | ~900 KB                                |

Manifest gains a `single_files: ["r6","r7","r8","r9"]` field so the
picker can detect which resolutions are available (older clients
hitting older manifests transparently fall back to r6 only).

### Picker: finest single-file ≤ chosen res

When `visibleShardsV2` returns more cells than `maxHexShards`, fall
back to the *finest published single-file ≤ chosen res*. So a
statewide z7 view that wants r7 picks `hex-r7.parquet` (one round
trip, ~250 KB) instead of jumping back to `hex-r6.parquet` (chunky).

Concrete plans across the matrix:

| Region        | Zoom  | Picker out                             |
|---------------|-------|-----------------------------------------|
| Statewide     | 6-7   | r7 single-file                         |
| Statewide     | 8-9   | r8 single-file                         |
| Statewide     | 10+   | r9 single-file (or sharded if zoomed)  |
| County        | 9-10  | r8 sharded (≤ 30 shards visible)       |
| County        | 11-12 | r9 sharded (≤ 30 shards visible)       |
| Muni          | 12-14 | r9 sharded (~3-7 shards)               |
| Muni dense    | 11+   | raw points (≤ 2 point shards visible)  |

### `shardUrlV2` — generalized single-file resolution

Was special-cased only for r6. Now: `shard === null` returns
`{base}/v2/hex-r{N}.parquet` for any N; `shard !== null` returns
`{base}/v2/hex-r{N}/{cell}.parquet` (sharded).

### `getResolution` clamp (already landed locally)

Defensive: render layer's `resolution` is `Math.min(effectiveHexRes,
getResolution(hexesArr[0].h3))`. Keeps columns sized to data res
even when the renderer would prefer finer (e.g. r10 zoom on r9
data).

## Verification matrix

Sanity-checked end-to-end (2026-04-30) via Chrome MCP + a Python
mirror of `pickFetchPlanV2` (`tmp/verify_picker.py`):

- [x] `/` (Home hero map, statewide z6.5, no `llz`): r7 single-file
- [x] `/?llz=…_8_…` (statewide z8): r8 single-file
- [x] `/?llz=…_10_…` (zoomed mid): r9 single-file (44 shards > 30)
- [x] `/?llz=…_11_…` (zoomed in, ~Newark): r9 sharded (~2-19 shards)
- [x] `/map` default (statewide z8.5): r8 single-file
- [x] `/map/c/hudson` (county-fit z11.5): raw points (~9 shards) —
  strict improvement over the pre-`maxPointShards`-bump r9-sharded plan
- [x] `/map/c/hudson` z13: raw points (5 shards)
- [x] `/map/c/hudson/jersey-city` z12: raw points (6 shards)
- [x] `/map/c/hudson/jersey-city` z14+: raw points (1-2 shards)
- [x] severity filter (`?s=f`): no rendering glitches; sparse fatal-only
  cells cluster along major roads
- [~] year-range filter (`?y=2023-2023`): only ~3% smaller bytes vs
  `?y=2019-2023` at /map z8.5 (single-file). At county-fit z12.1 with
  r9 sharded (Hudson) the narrow filter actually fetched *more* bytes
  (825 KB vs 644 KB). hyparquet's row-group pushdown for the year
  filter isn't biting the way the spec assumed — see follow-ups.

In each case, no visible hex grid is apparent — columns fully cover
their cells, with adjacent columns just touching at edges (inradius ≈
adjacent-center / 2).

## Out of scope (follow-ups)

- **Year-range pushdown effectiveness**: row groups in
  `hex-r{N}.parquet` are sorted by `year` and have correct min/max
  stats (verified via `pqm`), but observed fetched bytes barely shrink
  with a narrow year filter (`y=2023-2023` vs `y=2019-2023`: ~3%
  reduction at /map statewide; for sharded r9 at /map/c/hudson the
  narrow filter was actually slightly *larger*). hyparquet's
  `{ year: { $gte, $lte } }` predicate either isn't pruning row groups
  or our HTTP range-fetch coalescer is over-fetching. Worth inspecting
  the network ranges hyparquet emits.
- **CC pushdown**: hex shards have a `cc` column but no row-group
  ordering by `cc`. Adding `(cc, year, h3)` sort + RG stats would
  let `/map/c/{name}` skip non-county row groups in the single-file.
- **Severity column pushdown**: hex aggregates are already split per
  severity into separate output columns (`n_fatal`, `n_ped_inj`,
  `n_other_inj`, `n_pdo`); a fatal-only filter just zero-weights
  the others client-side. No bytes saved today.
- **Time-of-day / month buckets**: currently year is the only
  temporal index. Sub-year filtering is post-fetch.
- **Per-resolution `maxHexShards` cap**: today a single threshold
  governs all of {r7, r8, r9}. r9 has 6× more cells per area, so
  could justify a higher cap (single-file is bigger but rarely too
  big to fetch).
