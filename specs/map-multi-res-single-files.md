# Map v2: per-resolution single-file fallbacks

> Status (2026-04-30): in progress on laptop. Backend export +
> picker logic landed; visual verification pending across all
> region/zoom combinations before push.

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

Before pushing, sanity-check at:

- [ ] `/` (Home hero map, statewide, no `llz`): r7 single-file
- [ ] `/?llz=...` zoomed in: r9 sharded
- [ ] `/map` (full route, statewide): r7 single-file
- [ ] `/map/c/hudson` (county-fit): r9 sharded ~10 shards
- [ ] `/map/c/hudson/jersey-city` (muni-fit): r9 sharded ~3-7 shards
- [ ] zoom 14+ on JC: raw points (≤ 2 shards visible)
- [ ] year-range filter (e.g. 2023 only): smaller fetched bytes
- [ ] severity filter (e.g. fatal-only): no rendering glitches

In each case, no visible hex grid should be apparent — columns
should fully cover their cells, with adjacent columns just touching
at edges (inradius ≈ adjacent-center / 2).

## Out of scope (follow-ups)

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
