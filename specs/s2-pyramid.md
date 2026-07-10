# S2 Pyramid: Migrating Off H3

Status: **phases 1–3 landed** (client cell math + picker + `?grid=` param;
pyramid + D1 rollup built on `e`). Phase 4 (worker query support) is next.
See §Impl progress below.

## Motivation

Two H3 properties are causing friction:

### 1. Coarse per-level jump — 7× area, ~2.65× linear

Every H3 level is 7× the area of the next, or `√7 ≈ 2.65×` linear scale.
The picker has to snap to whichever level's cell diameter best fits the
current px-per-cell target — but the 2.65× gap between levels lands
outside the "just right" band for a lot of zooms. At z=7.5 embed:

- r7 ≈ 3.7 px per hex → dense enough that the honeycomb pattern reads
  as an artifact
- r8 ≈ 1.4 px per hex → sub-pixel, blurs into density (better) but 7×
  more cells / bandwidth
- Nothing in between

S2's 4× per level (2× linear) means the same zoom range fits ~40% more
distinct levels:

    levels_per_zoom_span(S2) / levels_per_zoom_span(H3) = log(7) / log(4) ≈ 1.40

So we gain finer control over the density/bandwidth trade-off — the
picker can land on a res whose cell diameter is close to the aesthetic
target instead of hopping over it.

### 2. Non-exact parent/child coverage — "boundary triangles"

H3 hex parents don't tile exactly into their 7 children. Each parent has
6 small triangular slivers along its edges (the "boundary triangles" or
BTs) where parent area and 7-children-union geometrically differ —
~5% of parent area. Empirically, ~7–8% of stations land in one BT per
level transition.

Consequences:
- `cellToParent` is exact for cell IDs but *not exact* for points inside
  a BT — a point can lie in one parent hex but its "true" H3 child at a
  finer level maps to a *different* parent.
- Heterogeneous-level coverings (mixing r{N} in one region with r{N+1}
  in another) can't compose cleanly under a monoidal count: you'd
  double-count or miss BT-population depending on which parent's tally
  you sum.
- Aggregation across levels for the same viewport requires either
  duplicated bucketing (H13-style: model each level's BTs first-class)
  or single-resolution queries that pay the coarse-level jump cost.

S2 children exactly tile their parents. Sums roll up losslessly.
Multi-resolution mosaics of a viewport (coarse where cells are sparse,
fine where dense) can be aggregated and compared without BT bookkeeping.

*This is the same reason `ctbk` (`~/c/ctbk`) abandoned H3 for its
station-counting work.*

### 3. Rendering — S2 cells work fine as circles

Square cells warped by Earth curvature look off at high latitudes if
drawn as filled squares. Drawing a **circle inscribed in each S2 cell**
gets us the same density-shaded look as H3 circle mode without the
warping artifact. Every visual property the H3 circle mode currently
has (density, aggregation, aesthetic smoothness at sub-pixel size) is
preserved. Filled-cell mode ("S2Layer" analog to H3HexagonLayer) is a
follow-up if we want a distinct "square-cells" viz.

## What's currently H3-dependent

Roughly ordered by lift required:

| Surface | Currently uses H3 | S2 replacement |
|---|---|---|
| Data pyramid on R2 | `pyramid/r{data_res}/{r4_shard_h3}.parquet`, 10 levels × 34 r4 shards, ~460 MB | S2 cell-id sharded pyramid (level 4 or 5 shard, level 4–15 data), similar total size |
| Cell-to-parent + range math (worker) | `h3-range.ts` — h3 bit math, cell-to-parent, cover-bbox → h3 cells | S2 cell-id range math — well-defined arithmetic, [`s2geometry`](https://s2geometry.io/) has a JS port |
| Client render | deck.gl `H3HexagonLayer` (hex mode), custom `ColumnLayer` with hex-inscribed circles (circle mode) | deck.gl `S2Layer` (square/cell mode), or reuse `ColumnLayer` with S2-inscribed circles |
| Picker | `pickHexResolutionForPixels` walks H3 radii table | `pickS2LevelForPixels` — walk S2 average-cell-diameter table |
| Debug widget | Zoom×res chart uses H3 radii | Same shape, S2 radii table |
| D1 rollup | `cells_r{res}(h3 PK, ...)` × 10 tables | `cells_s2_l{level}(cellid PK, ...)` × 15 or so tables |
| Muni / county polygon clip | S2 already has better spherical geometry primitives for point-in-polygon — actual small win here | Use S2's `S2Polygon.contains` |

None of it is throwaway — every H3 module has a symmetric S2 replacement.
The work is mechanical translation once we've picked the S2 JS lib.

## Migration paths (three options)

### Option A: Cutover

Build the S2 pyramid, switch the worker + client at once. High-risk (any
regression is a full rollback); clean-room outcome.

### Option B: Dual-stack (H3 + S2) behind a URL param

Ship the S2 stack alongside H3. `?grid=h3|s2` switches at runtime.
Client picker picks a level in either grid. Same worker instance serves
both. UI selector in the debug widget.

Pros: A/B compare live, no coordinated rollout, easy to revert.
Cons: worker bundle grows (both cell-id libs), pyramid on R2 grows by
another ~500 MB, ongoing maintenance of two rendering paths.

### Option C: Read-heavy S2 layer over H3 pyramid (rejected)

Would need per-crash lat/lon to re-cell into S2 at query time. Worker
CPU cost is prohibitive at wide zoom. Not viable.

**Recommended: Option B.** Kill H3 mode after S2 has proven out in a
month or so of real use.

## Rough size estimate

Building the S2 pyramid to match H3 coverage (levels ~ 5–15 for
data_res, level ~4 for shards):

- Per-cell rollup (all-years): ~2.4M rows total across 11 levels
  (matches H3 saturation) → ~300 MB SQLite (matches current
  `data/cells/cells.db` = 315 MB)
- Per (cell, year) parquet pyramid: ~460 MB (matches H3)

Wire cost per view: identical (labels are the dominant cost either
way — see `specs/labels-on-demand.md`).

## Worker query — S2 range math

H3's `pickCover` walks `h3-range.ts` to convert bbox → h3 cells at a
target res. S2's equivalent is `S2RegionCoverer` — libs like
`nodes2ts` / `s2-geometry-typescript` expose it. Given a bbox and a
target level, `getCovering()` returns a list of cell IDs plus their
levels. Multi-level covering falls out naturally (not a bolt-on like
H3's `pickCover` shard-tier logic).

## Picker semantics

The picker gains resolution because S2 cells step 2× per level instead
of 2.65×. The picker's "finest r whose diameter ≥ target" logic stays
identical — just walks S2's finer level table instead of H3's.

At z=7.5 embed with the same 2.5 px target:
- H3 r7: 3.7 px, r8: 1.4 px → picks r7
- S2 near-equivalent: level 8: ~4.4 km, level 9: ~2.2 km, level 10:
  ~1.1 km — one of these lands in the 2–3 px sweet spot at z=7.5.
  Specifically, at that mppx, level 9 ≈ 3.3 px, level 10 ≈ 1.7 px.
  Picker picks level 9 (3.3 px) — closer to target than H3's 3.7 or
  1.4 options.

Not dramatically better at every zoom, but consistently in-band vs
sometimes-outside for H3.

## Risks

- **JS S2 library maturity**: `nodes2ts` is unmaintained; alternatives
  `s2-geometry-typescript` and pure-Rust WASM bindings are less
  battle-tested than `h3-js`. Prototype early to shake out gaps.
- **Precision at high levels**: S2 cell IDs are 64-bit ints. JS `number`
  loses precision above 2^53 — mid-latitude levels 22+ are affected.
  Workaround (same as the D1 h3 fix in `queryCellsD1`): pass cell IDs as
  decimal strings, do math in BigInt. We only need levels ~5–15, so
  the ceiling is well under 2^53 — no BigInt needed.
- **Deck.gl `S2Layer`**: exists, but less common than `H3HexagonLayer`.
  Check if it handles our `ColumnLayer`-with-height-scale use case.

## Non-goals

- Not switching `ctbk` or other H3 users in one repo — this is
  crashes-only. `ctbk` will migrate on its own timeline.
- Not implementing "H13"-style BT-aware H3 aggregation as a fallback.
  If we're touching this, we're touching it to fix the root problem,
  not paper over it.

## Impl progress

### Phase 1 — Client cell math (landed)

- Added `nodes2ts` (1.2 MB unpacked; ESM; tree-shakeable). Chosen over
  `s2js` (4.4 MB unpacked) and older `s2-geometry` (unmaintained since
  2018). `nodes2ts` is TS-native, has recent `4.0.2` release (2026-03),
  no deps.
- New module `www/src/map/s2/index.ts`:
  - `latLngToToken(lat, lng, level) → S2Token` (14-char hex)
  - `tokenToLatLng(token) → [lat, lng]`
  - `tokenLevel(token) → level`
  - `tokenToParent(token, level) → S2Token`
  - `S2_DIAMETER_METERS[level]` — level radius table for the picker,
    same shape as H3's `H3_RADIUS_METERS`
  - `S2_MIN_LEVEL = 4`, `S2_MAX_LEVEL = 16` — range that overlaps H3
    r5–r15 for typical NJ viewport coverage
- Smoke tests in `www/src/map/s2/s2.test.ts` (5 passing): round-trip
  accuracy at level 14, token format stability, level extraction,
  parent walk correctness (JC ↔ Newark share level-8 parent).

### Phase 2 — Client picker + URL param (next)

- Add `pickS2LevelForPixels(target_px, zoom, lat) → level` — mirror of
  `pickHexResolutionForPixels`.
- Add `?grid=s2|h3` URL param via `use-prms` `enumParam`. `h3` remains
  the default until the pyramid lands.
- Wire the picker call site in `CrashMapSection` to switch on
  `?grid=…`. Debug widget shows the active grid + the picked res/level.
- Vitest unit tests for the picker, mirroring `picker.test.ts`.

### Phase 3 — Pyramid generation (`e` picks up)

**When to start**: after this spec's phase 2 lands (client picker +
`?grid=s2|h3` URL param). Phase 2 doesn't gate the data build — it
gates whether the client can meaningfully consume the output — but
building without a client to eyeball the results burns CI cycles.
Ask before starting if there's ambiguity.

**Layout on R2**:

```
data/cells/s2_pyramid/
  s2_l4/{token}.parquet   # per-cell counts at data level 4
  s2_l5/{token}.parquet
  ...
  s2_l16/{token}.parquet
```

The `{token}` in the filename is the level-4 shard's S2 token
(14-char hex, e.g. `89c25c1`). Level-4 cell area ≈ 980 km² — NJ is
covered by ~15 level-4 tokens. Total files ≈ 15 shards × 13 levels
= ~200. Total size should mirror the current H3 pyramid (~460 MB).

**Layout in D1**:

Per-cell all-years rollup, one table per level:
```sql
CREATE TABLE cells_s2_l{level} (
    cellid TEXT PRIMARY KEY,        -- S2 token, 14-char hex
    n_fatal INTEGER,
    n_inj_ped INTEGER,
    n_inj_other INTEGER,
    n_pdo INTEGER,
    n_vehs INTEGER,
    fatal_years TEXT,               -- JSON array
    sld_name TEXT,
    cross_sld_name TEXT,
    mun TEXT,
    county TEXT
);
CREATE INDEX cells_s2_l{level}_cellid ON cells_s2_l{level}(cellid);
```

*Note on cellid encoding*: unlike H3 (where we had to encode as
decimal-string TEXT to sidestep JS/D1's int64 limits — see the
`queryCellsD1` fix in commit `40834bee6d2`), S2 tokens are already
strings by design. This simplifies the D1 binding + range query
math. Range scans use `WHERE cellid BETWEEN lo AND hi` on the
lexicographic order of tokens, which matches S2's Hilbert-curve
ordering — no separate int64 range logic needed.

**Python S2 lib**: use `s2sphere` (well-established, pure Python,
`pip install s2sphere`). Rough API mirror of `nodes2ts`:

```python
from s2sphere import LatLng, CellId
cell = CellId.from_lat_lng(LatLng.from_degrees(40.7, -74.0)).parent(10)
token = cell.to_token()
level = cell.level()
```

**CLI shape**: extend `njdot/cli/cells.py` to accept `--grid s2`:

```
njdot compute cells pqt --grid s2   # build pyramid parquets
njdot compute cells db  --grid s2   # build D1 SQLite rollups
```

The existing `--grid h3` (or the default when unspecified) keeps
producing the current H3 outputs so both grids can coexist during
the migration.

**DVX targets** (new):
- `data/cells/s2_pyramid.dvc` — depends on the underlying per-crash
  parquets, mirrors the existing `pyramid.dvc`.
- `data/cells/cells-s2.db.dvc` — depends on `s2_pyramid`, mirrors
  the existing `cells.db.dvc`.

**When done, hand back**:
- Commits pushed to `h/main` (or via `git push e main` for pickup by
  the main session).
- Total pyramid + D1 sizes reported in the commit message so we can
  do the sanity check vs H3.
- One end-to-end spot-check: pick a level-8 S2 token covering
  Jersey City, verify its aggregate counts match the H3
  equivalent (r8's ~closest overlapping cell). Note: exact
  equality isn't expected because the cell boundaries differ; but
  the totals should be close (within a few %) because NJ is
  densely covered at both grids' level 8.

**What NOT to do**:
- Don't touch the worker (`cells-api/src/`) or the H3 pipeline
  outputs. Phase 4 handles the worker query paths, and the H3
  pyramid stays live so `?grid=h3` keeps working.
- Don't wire `data/cells/cells-s2.db` into `api/d1-import.dvc` yet
  — the worker binding (`CELLS_S2_DB`) doesn't exist until phase
  4. Producing the artifact is enough; import wiring is phase 4.

#### Phase 3 — landed (on `e`)

Built via `njdot compute cells {raw,sld,db,pyramid} --grid s2`; cell math in
`njdot/s2.py`, validated in `tests/test_s2.py`.

**What shipped**, and where it deviated from the plan above:

- **Cell math** (`njdot/s2.py`): one `s2sphere` per-crash pass tags each crash
  with its l16 cell id; every coarser level is derived by **duckdb UBIGINT
  bit-math** (`parent_sql`/`token_sql`), so the rollups stream memory-bounded.
  Two invariants are pinned by `tests/test_s2.py`: (1) `s2sphere` tokens ==
  the client's `nodes2ts` tokens (byte-for-byte); (2) the duckdb bit-math ==
  `s2sphere` for every level 4–16. Token lexicographic order == id order, so
  a TEXT-PK `BETWEEN` range scan aligns with Hilbert order.
- **Third DVX target added**: `data/cells/raw/s2_l16.dvc` — a shared S2 raw
  index (mirrors `raw/h3_r15`), so the one slow `s2sphere` pass feeds both the
  db and pyramid. The spec listed only `s2_pyramid.dvc` + `cells-s2.db.dvc`;
  the raw target is the natural dep of both.
- **Base level = 16**, data levels **4–16** in both db and pyramid. Client
  picker max is 17 → the worker should clamp 17→16 (phase 4).
- **Labels**: new `cells sld --grid s2` builds git-tracked
  `data/cells/s2-sld.parquet` (token → sld_name/cross_sld_name/mun/county),
  reusing `export_hex_sld`'s grid-agnostic nearest-MP + point-in-polygon. Baked
  at every level via own-token join (l16 coverage 99.7%). Mirrors how h3's
  `hex-sld.parquet` is git-tracked + referenced by md5 (no separate `.dvc`).
- **⚠️ Sharding — only 2 level-4 shards for NJ** (`89b`, `89d`), not the ~15
  the plan estimated → 2 files/level, **26 files** total (not ~200). Row-group
  pruning within each file still works, but phase 4 may prefer a finer shard
  level (e.g. `-s 6`) for better file-level fetch granularity; re-sharding is a
  one-line rebuild (`cells pyramid --grid s2 -s 6 -f`).
- **Sizes**: `raw/s2_l16` 89 MB (2 files) · `s2_pyramid` **157 MB** (26 files,
  3.1 M rows) · `cells-s2.db` **34.7 MB** (13 levels, w/ labels). The pyramid
  is well under the plan's ~460 MB estimate — s2 l16 (~120 m) is coarser than
  h3 r15, so far fewer cells (l16 = 210 k vs r15 = 1.15 M).
- **Validation** (the plan's "l8 ≈ h3 r8" spot-check premise was wrong — the
  grids' level-8 are very different physical sizes): instead used the stronger
  **count-conservation** invariant — summing each count over all cells at any
  level is **byte-identical** between s2 and h3 (`n_fatal=12,537`,
  `n_inj_ped=55,659`, `n_inj_other=1,541,178`, `n_pdo=3,299,293`,
  `n_vehs=8,372,869`), since both partition the same crashes. Plus a per-cell
  spot-check (JC l8 `89c25` vs independent recompute) and pyramid↔db
  consistency (per-year sums == all-years db), all exact.

**Not done** (correctly deferred to phase 4, per the guardrails): no worker
changes, no R2 serving push, no `d1-import.dvc` wiring. The DVX cache is pushed
to S3; the `.dvc` files + code are committed for pickup.

### Phase 4 — Worker query support

- Add `s2-range.ts` to `cells-api/src/` — S2 covering + range math for
  bbox → cells at a given level. `nodes2ts` `S2RegionCoverer` is the
  primary primitive.
- Extend `/v1/cells` to accept `grid=s2` alongside the existing `res=`
  and `cells=` params. When `grid=s2`, hit `cells_s2_l{level}` for
  the D1 fast path, `pyramid/s2_l{...}/*.parquet` for filtered queries.
- The `labels` mode plumbing (`?labels=nums|only|full` from
  `specs/labels-on-demand.md`) applies unchanged to S2 — the four
  string columns live in `cells_s2_l{level}` the same way they live
  in `cells_r{res}`.

### Phase 5 — Render + debug widget

- New rendering path: reuse the existing `ColumnLayer` from
  `StackedHexLayer` — S2 cell centers come from `tokenToLatLng`,
  cell diameters from `S2_DIAMETER_METERS[level]`, inscribed circle
  radius = `diameter * (√2 / 2)`. No new deck.gl layer needed.
- `ZoomResChart` gets a level column showing the S2 counterpart to
  the H3 zoom×res chart. Debug widget's grid pill toggles between
  H3 and S2 rows.

### Rollout order

- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 as listed. Phases
  1–2 ship independently (H3 keeps working). Phase 3 unblocks the
  worker (phase 4); phase 4 unblocks the client render (phase 5).
  Only once phase 5 lands does `?grid=s2` produce meaningful output.

