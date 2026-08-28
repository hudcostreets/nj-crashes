# Adopt `pyrmts-geo` in `cells-api` (S2 range math now upstreamed; covers/planner to evaluate)

Source: pyrmts session, 2026-08-27. Written after a consumer-setup review found crashes and pyrmts-geo running parallel S2 implementations that were co-designed but never wired together.

## Context — how we got two S2 stacks

crashes has been a design-target consumer of pyrmts since day one (pyrmts `SPEC.md`: "4 imminent consumers (ctbk live, awair next, tomat + crashes following)"), but the dependency edge never landed: no `pyrmts` in any crashes `package.json`/lockfile. Meanwhile both sides independently made the same H3→S2 pivot and built S2 machinery in parallel:

- pyrmts-geo `s2Index` (on `s2js`) + `minimalCover` DP: 2026-05-31.
- crashes `cells-api/src/s2-range.ts` (bigint range math for pruning): 2026-07-09 — five weeks later, unaware of the package (this session's transcript has 88 `pyrmts` mentions and zero `pyrmts-geo`).
- crashes h3-removal Phase 2 ("the worker speaks only S2"): 2026-08-23 — which dissolved the one adoption blocker pyrmts-geo's README used to name ("adopting `pyrmts-geo` would mean moving to S2").

The convergence question crashes itself asked in `specs/cells-temporal-axis.md` ("is there a shared library hiding here?") had the right instinct on the wrong axis: the shared library is the geo layer, not the temporal grid.

## What pyrmts already did (2026-08-27)

Upstreamed crashes' range math into `pyrmts-geo` as `s2-range.ts`, API-compatible for an import-swap:

- **Verbatim from `cells-api/src/s2-range.ts`** (same names, same signatures): `S2_LEAF_LEVEL`, `s2LsbForLevel`, `s2LevelOf`, `s2Parent`, `s2TokenToId`, `s2IdToToken`, `S2CellRange`, `mergeRanges`, `s2RangeForCell`, `s2RangeForCellToken`.
- **From `cells-api/src/cells.ts`**: `intersectRanges` (grid-agnostic `{lo, hi}` bigint intersect — it never belonged in a request handler).
- **New**: `s2RangesForCells(cells, baseLevel)` — the cover→merged-ranges composition both of crashes' consumers (hyparquet row-group `$or`, D1 `BETWEEN`) hand-roll.

All exported from the `pyrmts-geo` index. Tests ported and re-grounded on `s2js` (pyrmts-geo's canonical impl) — chained with crashes' existing `nodes2ts` + Python `s2sphere` verification, all three now agree on the same closed form. Module stays dependency-free (pure bigint math, no `s2js` at runtime), so it composes with `nodes2ts` ids/tokens unchanged. One semantic note the upstream tests pinned down: sibling cells' base-level ranges do NOT merge (they're separated by a `2·child_lsb` gap of finer-level ids) — `mergeRanges` only collapses nested/overlapping cover cells.

## Step 1 — swap `s2-range` for the package (mechanical)

1. Add the dep **via `pds` local link first** — `cells-api/.pds.json` already pds-manages `@rdub/file-tree`, so the flow is established there:
   ```
   cd cells-api
   pds init ~/c/pyrmts/js/packages/pyrmts-geo
   pds l pyrmts-geo
   ```
   The local `dist/` build in the pyrmts clone is current (contains `s2-range`; rebuild with `pnpm build` at `~/c/pyrmts/js` after any upstream edit). `pyrmts-geo` depends on `pyrmts` (workspace) — pds/pnpm-workspace resolution handles it from the local clone; if pnpm asks, `pds l pyrmts` too. This is the validation gate for the upstream code: pyrmts holds its `main` → `r/main` push until this step's suite is green, then builds dist and records the SHA below for the durable re-pin (`pds gh pyrmts-geo`-style), matching the ctbk pattern (develop on pds-local, re-pin to dist SHAs at push time). Add to `www/package.json` too if the client wants the range math.
2. `cells-api/src/s2-range.ts` → delete; re-point imports (`s2-range`, `cells.ts`, `s2-pruning.test.ts`, `s2-cover.test.ts`) at `pyrmts-geo`.
3. `intersectRanges` in `cells.ts` → import from `pyrmts-geo`, delete the local copy.
4. Optionally collapse `mergeRanges(shardTokens.map(...))` call-sites onto `s2RangesForCells`.
5. Keep `cells-api/src/s2-range.test.ts` for one commit as a belt-and-suspenders conformance check against the package (it now tests the import), then delete it — the same properties run upstream against `s2js`.

`nodes2ts` stays — it serves the client's point→cell conversions and the `S2RegionCoverer` in `s2RangesForPolygon`. This step removes duplicated math, not a dependency.

## Step 2 — evaluate mixed-level covers + budgets for the two open perf specs

`specs/autores-bins-budget.md` and `specs/cells-api-combo-maxcells.md` are both cell-budget problems, and pyrmts-geo has purpose-built machinery crashes hasn't looked at:

- **`minimalCover(s2Index, cells, …)`** — optimal mixed-level cover DP (fine cells where data is dense, coarse where it isn't) vs the current uniform "drop one level, re-read, re-check" `maxCells` walk. Same budget, strictly better fidelity per byte. This is also the capability pyrmts closed on a synthetic fixture two weeks ago precisely because no consumer exercised it — crashes' viewport picker is the real workload.
- **`PlanLimits` / `atomCount` / `PlanLimitError`** (pyrmts-geo planner, landed 2026-08-16) — query-cost preflight: reject/coarsen before reading, instead of discovering over-budget mid-decode (the l17+ 503s).

Serving a mixed-level cover against the current per-level D1 tables / parquet combos is not blocked: partition the cover's cells by their assigned data level, build per-level range sets (`s2RangesForCells(cellsAtLevel, level)`), one query per touched level, union the rows. Whether that beats the uniform walk in worker CPU is the evaluation — it may be a clear win only at wide zooms where density skew is large. Outcome feeds back into both specs; they should not be implemented on the hand-rolled budget path if this pans out.

## Step 3 — remaining upstream candidates (later, as they prove generic)

- `s2RangesForPolygon` — currently bbox-of-polygon → `nodes2ts` coverer → ranges. pyrmts-geo composition `s2RangesForCells(s2Index.bboxToCells(bbox, level), level)` is equivalent (different-but-correct covers from the `s2js` coverer). Low value to move until step 2 settles which coverer path serves.
- `coarsenCellsS2` (client-side re-aggregation) — candidate for `pyrmts-geo` if ctbk's map wants the same.
- Anything `manifest.ts`/`parquet.ts` shaped stays app-side; pyrmts' serving story for parquet-over-R2 runs through `pyrmts-cfw`, a separate conversation.

## Acceptance (step 1)

- `cells-api` vitest suite green with local `s2-range.ts` deleted; `s2-pruning`/`s2-cover` regression tests (the l17+ 503 bugs) still pass unmodified — they now guard the upstream impl.
- Worker bundle size delta ≈ 0 (the module is dependency-free; `s2js` must NOT enter the `cells-api` bundle via this — import from `pyrmts-geo`'s index is fine since `s2js` is tree-shakeable, but verify with a bundle check).
- One deploy + spot-check of `/v1/cells` at a street zoom (the pruning-dependent path).

## Status

- **pyrmts-side: implemented, local commit `d9cb681` (2026-08-27)** — `s2-range.ts` + tests in `pyrmts-geo`, exported; JS suite 532 green, `tsc -b` clean, local `dist/` built. READMEs updated (consumer entry corrected: crashes is on S2, adoption unblocked). **Push to `r/main` deliberately held** until crashes validates via the step-1 `pds l` link; dist SHA recorded here after that.
- **crashes-side step 1: validated green (2026-08-27).** `pds l pyrmts` + `pds l pyrmts-geo` linked; `cells-api/src/s2-range.ts` deleted; imports re-pointed (`cells.ts` re-exports `intersectRanges` for its test importers); `tsc` clean; **53/53 vitest** — `s2-range.test.ts` now conformance-tests the package, `s2-pruning`/`s2-cover` (the l17+ 503 guards) pass unmodified.
- **Bundle finding (pyrmts-side, 1-line, please land before pushing):** the barrel import pulled `s2js` into the worker bundle (856 KB) because `pyrmts-geo/package.json` lacks `"sideEffects": false`. Validated the fix in the linked worktree (left uncommitted there for this session to commit): with it, `s2js` refs drop to 0 and the bundle is **390 KB**. A `"./s2-range"` subpath export would also work; `sideEffects` is the general fix.
- **pyrmts: `sideEffects` landed + pushed + dist built (2026-08-28).** `01fb5e9` declares it on all four packages (`false`; `pyrmts-react` gets `["*.css"]` so `styles.css` imports survive tree-shaking). `main` = `01fb5e9` on `r/main`; `build-dist.yml` green (run 33193211997). **Dist SHA for the durable re-pin: `3bf5109f04535c4fadfb605c6c29d0d66e170393`** — `"pyrmts-geo": "https://github.com/runsascoded/pyrmts#3bf5109&path:/js/packages/pyrmts-geo"` (+ `pyrmts` at the same SHA if needed).
- **Step 1 COMPLETE (2026-08-28).** crashes re-pinned durable (`pds gh` → `pyrmts` + `pyrmts-geo` @ `3bf5109`), validated against the dist artifacts (tsc, 53/53, `s2js`-free 390 KB bundle), committed `de02dd7ed4c`, deployed the worker via `cells-api/deploy.dvc` (18:13Z), and spot-checked the pruning path live: `/v1/cells?cells=89d&res=15&years=2016-2020` → 200, `source: pyramid`, 71,505 cells. Next: step 5's deferred deletion of the conformance copy of `s2-range.test.ts`, then step 2 (the `minimalCover` / `PlanLimits` evaluation).
