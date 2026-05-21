# Page weight & homepage API perf

Deferred follow-ups from the 2026-05-21 page-size pass. The quick win
that session — footer logo `hccs.png` 928×928/126KB → 128×128/24KB —
landed (`cold-homepage` perf-har golden 3.17MB → 3.07MB). These four
are parked: each is more than a quick win.

## 1. Lazy-load `hex-sld.parquet` (~0.5MB)

`useHexSld` (in `CrashMap`) eagerly fetches the hex-tooltip
street-name sidecar on map mount, but it's only needed once a tooltip
shows. Deferring it to first map-hover saves ~0.5MB for visits that
never hover the map (the common case for a quick look).

Attempted 2026-05-21: a `useHexSld(enabled)` gate flipped by the
deck.gl `ColumnLayer` `onHover` → reverted. The trigger wouldn't
verify — tooltips fired (so `onHover` ran) but the `setState` →
effect → fetch chain never kicked off, root cause unclear (suspect
the lazy-loaded `CrashMap` chunk under Vite dev, or a deck.gl
layer-closure issue).

Retry with a **non-React trigger**: a `pointerenter` listener on the
map container DOM node calling `loadHexSld()` directly, or
`requestIdleCallback` after first map render (deferred-but-automatic;
doesn't save bytes for non-hoverers but moves it off the critical
path).

## 2. Slim the v2-manifest fetch on the homepage (122KB)

`CrashMapSection` fetches the full `manifest.v2.json` (~122KB) purely
to read county/muni bounding boxes for the initial viewport — the
map's cell data now comes from cells-api. Emit a small dedicated
`bboxes.json` (county + muni bboxes only, ~30KB) from the map
pipeline and fetch that instead. The `/map` route (`useCrashData`)
still needs the full v2 manifest, so this is homepage-only.

## 3. `api.ts` → TanStack Query

`useApi`/`useApiEager` are raw `useEffect` + `fetch` with no dedup or
cache. On `/`, every API call (`year-stats`, `count`, `crashes?…`,
`occupants?…`) fires 2× — that is React StrictMode double-mounting in
dev (a prod build fires each once), *not* prod waste. But there's
also no cross-component dedup and no cross-navigation cache. Migrate
to TanStack Query (the project default) for request dedup + caching.

## 4. D1 query latency — index the crashes date column

`count?before=…` (~1s) and `crashes?before=…&limit=10` (~0.9s) are
the slowest homepage requests — D1 queries on the `crashes-api`
worker. Confirm the D1 `crashes` table has an index on the date
column; `count(*)` with a `before=` filter table-scans without one.
Pagination `count`s are inherently expensive — consider a
cached/stored count rather than recomputing per request.
