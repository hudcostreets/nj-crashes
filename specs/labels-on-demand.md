# Labels-on-Demand: Hybrid `nums-first + hover-fetch` for Cells API

Status: draft, not started.

## Problem

At wide zoom the default `/v1/cells` payload is dominated by 4 string columns
(`sld_name`, `cross_sld_name`, `mun`, `county`) — measured at ~170 B/cell
across a 20k-cell payload = **3.4 MB**. The counts + h3 alone are ~60 B/cell,
so labels account for **~65% of the wire size at wide zoom**.

Labels are only useful when a user hovers a cell. At wide zoom, hexes are
1–5 px across — hover-targeting a specific cell is imprecise; the aggregated
counts are the actual signal. Sending labels for every cell up front pays for
information the user cannot usefully consume.

`e` already shipped `?labels=full|nums|only` on the worker side
(commit `a683722e911`). What's missing is client-side wiring to use it, plus
a mechanism to fetch labels for the specific cell the user is hovering
without a full second round trip.

## Design

Three-phase load per view:

1. **Initial paint (immediate)** — client fires the usual `/v1/cells` but
   passes `labels=nums` whenever the projected payload exceeds a threshold
   (details below). Renders as soon as bytes land: counts + colors, no
   labels. Tooltip degrades gracefully (existing `CrashTooltip` behavior:
   `{sldLabel && …}` chunks omit).
2. **Hover-fetch (interactive)** — when the user hovers a cell whose labels
   aren't yet in the client cache, fire a targeted `/v1/labels?h3=...`
   request. Debounced 100 ms so a rapid mouse-sweep across N cells fires
   one batched request for the last-lingered cell (or a small coalesced
   set). Response populates the client's `labelsCache: Map<h3, Labels>`
   and the tooltip re-renders.
3. **Background fill (eventual)** — after the initial paint has settled
   (say 500 ms of no zoom/pan), kick off a `labels=only` background fetch
   for the current view's cells. Response merges into `labelsCache`.
   Every subsequent hover is a cache hit, no round trip.

The three phases mean: **paint is fast**, **hover is snappy** (single
sub-100 ms round trip the first time, instant after), and **eventually all
hovers are instant** without ever having paid the wide-zoom string tax.

## Thresholds

Client-side gate on which mode to fire:

```ts
// Sent as `?labels=nums` when the projected full-labels payload would
// dominate wire time. Rough estimate from local measurements:
//   nums-only  ≈ 60 B/cell
//   full       ≈ 170 B/cell  (i.e. +110 B/cell from strings)
// If (n_cells × 110) > BYTES_BUDGET → nums-first.
const LABELS_BYTES_BUDGET = 500_000  // ~500 KB of labels — tune from evidence
if (projectedCells * STRING_BYTES_PER_CELL > LABELS_BYTES_BUDGET) {
    labelsMode = "nums"
}
```

`projectedCells` comes from the picker's `pickerInfo` (or the manifest, if
we keep an approx per-res populated-cell count there).

Simpler alternative: gate purely on res. `res < 12` → `nums`, `res >= 12`
→ `full`. Less precise but no manifest changes needed. Start with this;
migrate to bytes-budget when we have a stable calibration.

## Worker: new `/v1/labels` endpoint

Existing `?labels=only` requires a full shard fetch just to pull labels
for one cell. A per-cell endpoint is O(1) against the `cells_r{res}`
D1 rollup (h3 is INTEGER PRIMARY KEY):

```
GET /v1/labels?h3=<h3>[,<h3>...]&res=<r>
→ [{ h3, sld_name, cross_sld_name, mun, county }, ...]
```

Implementation is a thin wrapper around the existing D1 path
(`queryCellsD1` in `cells-api/src/cells.ts:347`): drop the count columns,
select only the 4 string columns. Same `h3 BETWEEN` range logic since
`h3` may arrive as a hex string (TEXT). Should be < 20 ms end-to-end for
a batch of 25.

Fall through to parquet when D1 is unavailable, same as the existing
default-query fast path (~5 s ceiling for a whole shard — acceptable
since this is a background fetch, not a blocking one).

## Client integration

New module `www/src/map/labels.ts`:

```ts
type Labels = { sld_name?, cross_sld_name?, mun?, county? }

const labelsCache = new Map<string, Labels>()

/** Debounced hover-fetch. Called from `CrashTooltip` when it needs
 *  labels for a cell not yet in cache. */
export function requestLabels(h3: string, res: number): Promise<Labels>

/** Kicked off ~500 ms after initial paint. Merges into `labelsCache`
 *  when it resolves. Safe to call repeatedly; skips if a background
 *  fetch is already in flight for this view. */
export function backfillLabels(cells: CellRow[], res: number): void
```

`CrashTooltip` becomes async-aware: renders "loading label…" for the
brief window between hover and first response. If the cell already has
labels (either from `labels=full` mode or a cache hit), tooltip is
instant like today.

## Cache eviction

Keep the last N cell-labels (N ≈ 1000). LRU on hover time. Prevents
unbounded growth as the user pans across the state.

## UX indicators

- Debug drawer widget shows `labels: nums | full | mixed (M/N cached)`
  so it's clear when the tooltip may need a round trip.
- Tooltip's "loading label…" placeholder is subtle (opacity 0.6) — a
  visible "still fetching" state, not a disruptive spinner.

## Instrumentation

Extend the metrics block (`ZoomResChart`):
- `labels: nums+cache 340/1200 · +12 KB` — mode, cache size, additional
  bytes from hover fetches
- Effectively splits the current `fetched: N · K KB` into
  `fetched: N · K KB (nums) + L KB (labels)` when hybrid is in use.

## Rollout

1. **Client-only phase**: send `labels=nums` at `res < 12` using the
   existing worker; hover-fetch uses `/v1/cells?labels=only&cells=<h3>`
   (worst case — pulls extra bytes but proves the wiring). Measure
   bandwidth cut and hover latency.
2. **Worker phase**: land `/v1/labels` endpoint. Client swaps
   hover-fetch URL. Measure hover-latency improvement.
3. **Background fill**: add the 500 ms debounce + `labels=only` background
   pull. Measure "time-to-all-hovers-instant".

Each step is independently deployable — no worker/client coupling gate.

## Risks

- **Hover feels sluggish** if the first-hover round trip is >150 ms. D1
  should keep it <50 ms; parquet fallback ~5 s is the failure mode. If
  we routinely see D1-cold-start `exceededMemory` (task #98 territory),
  this feature amplifies user-visible pain because it fires on every
  first hover, not just on load.
- **Race between hover-fetch and background-fill** — both write to
  `labelsCache`, values match (same D1 rollup source), no invalidation
  problem.
- **Cache thrash across pan**: user pans, new cells appear, old cells
  evict from cache. Re-panning back hits nothing. LRU size 1000 keeps
  a whole city view resident; state-wide panning may still evict.

## Non-goals

- Not restructuring the pyramid. Labels stay in the per-cell rollup
  where they already live.
- Not touching hex mode's visual behavior — labels-on-demand is
  invisible to the rendering path.
