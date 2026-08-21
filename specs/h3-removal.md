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
