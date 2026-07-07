# cells-api: worker-side adaptive coarsening on the combo path

## Problem

Circle/hex mode at coarse zoom (e.g. z=10.94 Bergen) fetches ~64k r10
cells per shard × 3-5 shards → 3-5 MB gzipped per viewport response.
The visual only needs a fraction of that: at that zoom, r10 cells are
~2 px wide — well below one screen pixel per cell — so the client
blurs them into a rasterized heatmap regardless of how many it fetched.

The legacy (non-combo) request path already has a `maxCells` mode
where the worker walks coarser (drops one res level, re-reads,
re-checks) until `cells.length <= maxCells`. The combo path
(`?shard_res=X&res=Y`) intentionally skipped it because the client
was pre-picking a combo whose total cell budget "should" fit.

Reality check: per-shard cell counts vary 10-100× across a single
NJ-wide viewport (rural r10 shards have ~5k cells; urban ones have
~60k). A single combo choice can't be tight everywhere.

## Design

Extend the combo path to accept `maxCells` and apply it **in-worker,
per-shard, in memory** — no coarser-res parquet re-read.

### Wire

Client sends `?shard_res=X&res=Y&maxCells=N` on combo requests
(currently only sent on legacy path). Worker interprets:

- Read shard's pyramid at `(shardRes, res)`.
- Build the `CellOut[]` (year/severity filter + polygon clip, as today).
- **New**: if `cells.length > maxCells`, coarsen in-worker by
  `cellToParent(h3, res-1)` + sum the count fields. Repeat until
  `cells.length <= maxCells` or `res === MIN_RES`.
- Join sld sidecar against whatever res the cells ended up at.
- Return with `res: actualRes` (client already uses this as truth).

Aggregation semantics for the coarsening step:

- `n_fatal/n_inj_ped/n_inj_other/n_pdo/n_vehs`: **sum** across children.
- `fatal_years`: **union** across children.
- `h3`: replaced with parent's h3 string.

Sld-join uses the coarsened h3s. Sidecar has entries at r6-r11; cells
coarsened to r9 look up r9 h3 directly, r10 looks up r10, etc.
`getResolution(h3) > 11 ? cellToParent(h3, 11) : h3` handles coarser-
than-11 already.

### Worker changes (`cells-api/src/cells.ts`)

Two things:

1. Extract `coarsenCells(cells, toRes)` helper: parent-aggregate via
   `cellToParent`. Uses same tier fields as `CellOut`.
2. Add a while-loop after the shard read in the combo branch of
   `handleCellsRequest`: `while (maxCells != null && cells.length >
   maxCells && res > MIN_RES) { res--; cells = coarsenCells(cells,
   res) }`.

Existing legacy-path adaptive is unchanged.

### Client changes (`www/src/map/useCellsApi.ts`)

- `buildBatchUrl`: send `maxCells` on both paths (combo + legacy).
- Client already trusts `response.res` for rendering; cross-shard
  `rollupCellsToRes` normalizes when different shards return different
  res. No further plumbing.

Existing client-side coarsening (`rollupCellsToRes` in the useCellsApi
result-merge) is safe — it walks fine → coarse, which is what we want
if the worker returns a shard at a coarser res.

### Choosing `maxCells` per request

Current CELLS_BUDGET = 100k total across the viewport response. A
typical viewport has 3-25 shards. Client already snaps cover to
combos; add:

```ts
const maxCellsPerShard = Math.floor(CELLS_BUDGET / cover.length)
```

Floor at ~5000 (leave headroom for a single-shard corner case). Cap at
20000 (don't over-restrict when a shard covers dense urban area with
legitimate detail).

## What this does NOT do

- Doesn't change what hex-mode users see visually — worker returns
  aggregated cell counts, client renders whatever res comes back at
  identical hex-tessellation semantics. Chunkier hexes where the
  worker coarsened; unchanged where it didn't.
- Doesn't touch parquet transport / JSON payload compression. That
  stays a followup once we see whether (1) is enough.
- Doesn't touch the client's cover-picker. Same shard fanout, same
  URL cache keys.

## Rollout

Independently deployable. Worker deploy first (backwards-compatible:
old client ignores `res` field being different if it happens to be
coarser than requested; nothing breaks). Client change lands after,
starts sending `maxCells` on combo path.

## Tests

- `cells-api/src/cells.test.ts`: add cases for `coarsenCells` + the
  combo-path adaptive loop with `maxCells`.
- Live smoke: hit the Bergen z=10.94 URL; verify (a) response cell
  count is ≤ maxCells per shard; (b) `res` returned is 8 or 9 for the
  urban shards; (c) visual on the map is unchanged for rural shards.
