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

### Phase 2 — worker drops H3 (after Phase-1 client is *deployed*, not just merged)

- cells-api: remove `grid=h3` support + H3 pyramid routes. Brief overlap
  where the worker still accepts `h3` protects stale cached clients; a week
  is plenty (bundle hashes roll on the next daily deploy).

### Phase 3 — data GC

- `map.dvc` cmd: stop generating H3 pyramids (hex shards + `hex-r{6,7,8,9}`
  single-files). Local re-run, then `map_sync.dvc` `aws s3 sync --delete`
  (same pattern as the v1 GC, which shrank `map/` 377→127 MB).
- `hex-sld.parquet` (H3-keyed tooltip sidecar): the S2-keyed
  `data/cells/s2-sld.parquet` already exists — the worker's sld multiplex
  already joins per-cell for S2 responses (this session's JC fetch carried
  `sld_name`/`cross_sld_name`), so client-side `useHexSld` usage should
  already be vestigial for the map; verify, then GC hook + parquet.

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
