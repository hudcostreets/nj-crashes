# Remove H3: single-grid (S2) map stack

## Decision

Rip out the H3 grid entirely — code, worker support, pyramid artifacts,
naming. Ryan 2026-08-21: "I see no reason to keep it around." Agreed; the
case for keeping it has evaporated:

- **S2 has been prod default since `7ca85f99ba1` (2026-07-12)** — `?h3` is an
  opt-in escape hatch nobody uses, and the S2 picker is now live-tunable via
  `/tune` + `map/tuning.json`, so "escape hatch while S2 soaks" is moot.
- **The points-mode fetch path (`useCrashData` / `pickFetchPlanV2`) is already
  dead code** — no callers in the render tree (CrashMapSection imports only the
  `CrashFilter` type); all prod data flows through the cells-api worker.
- **pyrmts is off H3 entirely** (h3-js demoted to test-only devDep,
  `getSpatialIndex` throws with no default backend, Python `pyrmts_geo`
  deleted); ctbk likewise. We're not a pyrmts consumer but the ecosystem
  direction is uniform.
- Costs of keeping it: `h3-js` ≈195 KB min in the bundle; H3 pyramid
  generation in the daily pipeline; H3 shards + single-files in R2; dual-grid
  branches through picker/fetch/render/debug code; H3-keyed `hex-sld` sidecar.

Exception kept: **nothing**. (pyrmts kept H3 as a second conformance backend
for `SpatialIndex` tests; we have no analogous abstraction to conformance-test.)

## Sequencing (deploy-skew-aware)

Worker (`wrangler deploy`, immediate) and www client (git → daily `deploy.dvc`)
deploy separately — never ship half a coordinated change
(`feedback_cells_api_deploy_skew`). Remove in consumer→producer order:

### Phase 1 — client stops speaking H3

- `CrashMapSection`: drop `?h3` URL param + `grid` state; hardcode s2. Drop
  the H3/S2 toolbox toggle row; relabel the "Hexbin" mode button → **"Bins"**
  (legacy name predates S2 squares-rendered-as-circles).
- `CrashMap`: drop `effectiveHexRes` + `pickHexResolutionForPixels` (S2
  picker only), H3 branches in bin/coarsen/renderRes, the h3-js
  `polygonToCellsExperimental` grid-overlay (port to S2 via `tokenBoundary`
  or ctbk's `s2geo.ts` edge-arc approach if the debug overlay is worth
  keeping), `H3_RADIUS_METERS`.
- `StackedHexLayer`: keep `binIntoCells` (grid-agnostic core, added
  `6ca7e85c718`); delete `binIntoHexes` + `coarsenHexes`' H3 parent walk
  (S2 parenting via `tokenToParent` if client coarsening is still wanted —
  today only the H3 path coarsens client-side).
- `useCellsApi`: default + only grid = s2; drop `"h3"` from types and the
  `grid=` request param (after Phase 2 the worker rejects it anyway).
- `HudsonMap` (`/hudson` legacy route, static JSON + client H3 binning):
  either switch to `binIntoS2Cells` (one-line now) or retire the route.
  **Open question for Ryan** — it predates the statewide map; `/map` +
  county filter supersedes it.
- `picker.ts` / `v2.ts`: delete dead `pickFetchPlanV2` H3 plans; if points
  mode is ever rewired it comes back S2-shaped (client binning is ready).
- Drop `h3-js` from `package.json`. `h3cover.ts` + its test go entirely.
- Tests: `h3cover.test.ts` deleted; `picker.test.ts` H3 cases deleted or
  ported; run the golden/HAR perf tests.

### Phase 2 — worker drops H3 (done 2026-08-23; **deploy gated** on Phase 1)

`cells-api` is S2-only. Gone: the H3 branch of `handleCellsRequest` (which
becomes the former `handleCellsRequestS2`), `queryPyramid`, `queryCellsD1`,
`queryRaw`, `coarsenCells`, `cellInPolygon`, the `bigintToHex`/`hexToBigint`
int64 encoding pair, `h3-range.ts` + its test, and the `h3-js` dependency.

Decisions worth recording:

- **`grid=h3` 400s, it isn't ignored.** The non-goal below ("`?h3` URLs fall
  through") is about the *client's* URL param. A worker request that says
  `grid=h3` and gets back S2 tokens would feed them to `cellToLatLng` and
  render garbage; a 400 fails visibly instead.
- **`mergeRanges` moved to `s2-range.ts`** — it's generic over `{lo, hi}`
  bigints, and it was the S2 path's only reason to import `h3-range.ts`. It
  also stopped mutating its inputs on the way (it widened `top.hi` through a
  shared reference; every current caller passes freshly-built ranges, so this
  was latent, not live).
- **`cells` can no longer be validated by shape alone.** An H3 id is 15
  lowercase hex chars, which the S2 token regex (1-16 hex) admits. It fails
  downstream instead — `s2LevelOf` reads it as level 28 and the handler 400s
  on a shard finer than the requested level. Recorded as a test.
- `consolidated.test.ts` → `s2-pruning.test.ts`: the H3 range-pruning half was
  deleted, but the row-group-pruning + footer-cache assertions are the only
  coverage of the load-bearing optimization on the *surviving* path (the S2
  shard cover is statewide at every zoom, so range pruning is the only thing
  keeping a street-zoom request from decoding a whole level file). Ported to
  `s2_pyramid/s2_l13/89d.parquet` and now actually runs.
- `CellsResponse.source` loses `"raw"` and the client's copy of the union
  gains `"d1"` — it had never listed the path that serves most requests, so
  the debug overlay reported every D1 response as `pyramid`.

**Not yet deployed.** Phase 1 (`a2c646e1624`) is still unpushed, so the
deployed client is the pre-Phase-1 one. It defaults to S2 and only sends
`grid=h3` behind the opt-in `?h3` URL param — but the ordering rule stands:
push + let `deploy.dvc` ship the client, *then* `wrangler deploy`.

### Phase 3 — data GC (code done 2026-08-23; remote GC pending)

Landed:

- **`njdot compute cells` is S2-only.** `--grid` is gone from `raw` / `pyramid`
  / `db` / `sld`; `pyramid-combos` (H3-only) is deleted along with
  `_build_pyramid_level`, `_load_sld_lookup`, the three `h3-js` vectorizers,
  the `_MP_*` fork-pool globals, and `_cells_db_h3`. `cells manifest` is
  ported to S2 (`base_level` / `shard_level` / `s2_l{N}` row counts, schema 5)
  — the worker only reads `data_version` + `year_range` from it, but it was
  still being built by walking `raw/h3_r15`.
- **The daily job was refreshing the dead grid.** `daily.yml` rebuilt
  `raw/h3_r15` + `cells.db` and imported `cells` → `CELLS_DB` every day, while
  `cells-s2.db` → `CELLS_S2_DB` — the binding that actually serves the map —
  was only ever built by hand. Both stages and `api/d1-import.dvc` now point at
  the S2 artifacts. **First S2 daily run will produce a large exact-diff**
  against a D1 that's months stale; consider one `--full` import first.
- **`export_map_v2` emits only `manifest.v2.json`.** Its `points/{r5}` +
  `hex-r{6,7,8,9}` tree was the H3-era R2-direct fetch stack; the client reads
  exactly three fields from that manifest (`year_range`, `county_bboxes`,
  `muni_bboxes`), so `shards` / `shard_bboxes` / `single_files` / `row_counts`
  went too (manifest schema 3, and `MapManifestV2` slims to match).
- **`export_map_data`** — the whole v1 layout, no `.dvc` stage, its outputs
  `rm -rf`'d by `map.dvc` — is deleted. Its one live export, `_build_base`,
  moved to `njdot/map_base.py`.
- **`export_hex_sld` / `reshard_hex_sld`** deleted with `hex-sld.parquet`
  (git-tracked, 7 MB). Their two grid-agnostic lookups (nearest-milepost,
  point-in-polygon), which `cells sld` imported across the H3/S2 line, moved
  to `njdot/sld.py` keyed on a generic `cell` column.
- `h3` dropped from `pyproject.toml`. No Python H3 dependency remains.
- The stale `perf-har` goldens were regenerated: they still recorded H3
  requests (`res=14&shard_res=9` + a 130-cell r9 cover) and a 15 MB
  `hex-sld.parquet` fetch, so they had been failing since the S2 default
  flipped. `map-perf.spec.ts` also went green again — its readiness signal
  (`__crashMapDebug.lastBinMs`) was only published on the client-binning path,
  which stopped running when cells-api became the sole source of cells, so
  both its tests burned a 3-minute timeout. `CrashMap` now publishes the hook
  on the prebinned path too, with `binSource: "server"`.

Still to do — **destructive, needs sign-off**:

- `aws s3 sync --delete` for `njdot/map` (`map_sync.dvc`) — drops the
  `v2/points` + `v2/hex-r*` + `hex-sld.parquet` objects. Same pattern as the
  v1 GC, which shrank `map/` 377 → 127 MB; this one should take it to ~1 MB.
- R2 `cells/pyramid/**` (460 MB) + `cells/raw/h3_r15/**` (89 MB), via
  `njdot compute cells push` (it syncs `--delete`) or a direct delete.
- The `cells` D1 database (315 MB) — no longer bound by any worker.
- `dvx gc` on the S3 remote for the orphaned `pyramid` / `raw/h3_r15` /
  `cells.db` objects.

### Phase 4 — naming sweep (mechanical, separate commit)

`StackedHexLayer`→`StackedCellLayer`, `StackedHex`→`StackedCell` (type),
`binIntoHexes` refs, `hexPxTarget`→`cellPxTarget`, `hexes`/`renderHexes`
locals, `hexOpacity`/`hexDesaturate` props, `hex-grid` layer ids, comments.
No behavior change; keeps grep hygiene honest after the functional phases.

### Phase 4a — semantic hazards (done 2026-08-22)

Deferring the naming sweep as "mechanical" turned out to understate it: an
H3 *value* wearing an S2 label is a live bug, not a cosmetic one. Ryan, on
finding one: *"from the `res` bug it sounds like you didn't do that
completely/correctly, maybe worth another pass there?"* — an audit of both
`www/src` and `cells-api/src` for H3-derived values applied to S2 data
found twelve. Fixed:

- **`LABELS_NUMS_RES_THRESHOLD = 12`** — an H3 resolution (r12 ≈ 19 m)
  compared against S2 levels (l12 ≈ 1.9 km), so the label gate never fired
  and every request paid a 45-50% label tax. Now `LABELS_MIN_S2_LEVEL = 18`.
  (This is the one that prompted the pass; see
  `specs/cells-compact-wire-format.md`.)
- **`pickS2LevelForPixels` returned levels 0-3** — it walked every key of
  the edge table (which carries the unabridged published stats table)
  starting at `levels[0]` = 0, with no clamp. `useCellsApi` silently
  clamped to 4 while every debug readout showed the unclamped value. Now
  iterates `[S2_MIN_LEVEL, S2_MAX_LEVEL]`.
- **The picker's early `break`** assumed effective edge decreases
  monotonically in level, which `S2_PICK_MULT` (0.55 at l20, 0.4 at l21)
  no longer guarantees — a dip at level N made N+1 unreachable. Now scans
  the full range.
- **`S2_DIAMETER_METERS` held edge lengths** — the name was inherited from
  H3's vertex diameter (`2 × H3_RADIUS_METERS[r]`) while the quantity
  changed. Every consumer already treated it as an edge, so only the name
  was wrong, but it's the kind of wrong where the next `area = π(d/2)²` is
  a silent factor-of-2. Renamed `S2_EDGE_METERS` and moved to a
  dependency-free `s2/edges.ts`.
- **A duplicate edge table in `StackedHexLayer`** ("keep in sync") had
  already drifted — it started at level 4 where the original started at 0,
  and its `?? 478` fallback drew any out-of-range level as level 14. Both
  now share `s2/edges.ts`; the fallback is a clamp.
- **Snap-buttons didn't land on their labelled level**: the snap px was
  computed from the raw edge while the picker compares against the
  `pickMult`-scaled edge, so the l20/l21 chips landed one to two levels
  coarser than their own label. Both sides now go through
  `s2PickEdgeMeters`. Same fix in `ZoomResChart`'s px ticks, whose
  transition lines come from the picker.
- **`res: 9` fallback** in `CrashMapSection` — H3 r9 (≈174 m, the old
  statewide default) as an S2 level, where l9 is a 15 km cell. Now a named
  `S2_FALLBACK_LEVEL`.
- **`hexPxTarget ?? 1.2`** in `useCellsApi` — the H3-era *raw* px target,
  unscaled by `S2_TARGET_FACTOR`, so the fallback path fetched a different
  level than the one the section computed and displayed.
- **`shard_res` validated against `[0, 15]`** (H3's resolution ceiling) on
  a param the S2 client sends on every request, where levels run to 21.
  Now grid-dependent.
- **Nothing bounded a response.** `CELLS_BUDGET = 100000` was justified
  entirely by H3 cell-count arithmetic ("statewide r9 fits in ~66.5k
  cells"), *and* was inert: batched requests never sent `maxCells`, and
  the client-side coarsen was deleted in Phase 1. A Hudson-fit l17
  viewport measured 168k cells / 30 MB with nothing to stop it. Replaced
  by `CELLS_MAX = 150_000`, actually sent, documented as a backstop above
  the picker's target rather than a routine coarsener.

Left for Phase 2/3 (they own the code being deleted): the S2 path's
dependency on `h3-range.ts` for `mergeRanges` (correct today — it's
generic over `{lo, hi}` bigints — but it dies with the file, so it wants
moving to a grid-agnostic module), and `parseCellsRequest` still defaulting
`grid` to `h3`.

Left for the cosmetic sweep: the `h3` field name on the wire (worker and
client both carry S2 tokens in it), `StackedHexLayer`/`StackedHex`,
`hexPxTarget`, `renderHexes`, `kind: "hex"`, and the H3 formulas in
`ZoomResChart`'s doc comment.

## Riders (small, same area)

- **Squares viz true boundaries** (optional): Squares mode draws axis-fixed
  `diskResolution: 4` columns at inscribed radius — deliberate area-matching,
  but at fine levels the true S2 cells are visibly sheared parallelograms
  (~80° axes, ~10° tilt at JC — see `6ca7e85c718` message). A
  PolygonLayer over exact cell quads would tile honestly. Decide whether
  Squares means "footprint" (keep) or "geometry" (add this).
- The "is this not a hex grid?" finding, for posterity: S2 l20 centers at JC
  form a sheared lattice with 6 near-equidistant neighbors
  (7.87 / 8.60 / 10.54 m) — perceptually hex despite being a quad tree. Not
  fixable, not a bug; worth a line in the map README so the next person
  doesn't re-audit it.

## Non-goals

- No change to the S2 pyramid itself, tuning values, or `/tune`.
- No BC shims: `?h3` URLs just fall through to the S2 default (the param is
  ignored, not an error).
