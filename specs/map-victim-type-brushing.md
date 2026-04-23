# Map ↔ CrashPlot brushing + victim-type filter

## Motivation

On `Home.tsx` statewide/county/muni pages the **`CrashPlot`** bar chart ("NJ
DOT Crash Data") and the **`CrashMapSection`** embed are stacked vertically
for the same scope (year range, county, muni) but do not interact. Today:

- `CrashPlot` stacks *Fatal / Injury / Prop. Damage* bars by `severity`.
- `CrashMap` renders the same 3 severity tiers as stacked hex columns
  (`StackedHexLayer`) with matching colors (red / orange / pale-yellow).
- They share a scope but have independent severity filters.

Two missing affordances the user has asked for:

1. **Brushing** — click a stacked segment (or legend item) on `CrashPlot`
   and see the map filter to that severity (or victim type).
2. **Victim-type filter** — a separate dimension from `severity`
   (driver / passenger / pedestrian / cyclist) that both the plot and map
   can filter on.

## Current data shape

### Points (`by-year-county/YYYY-CC.parquet`)

Already per-crash. Columns include:

- `severity` — `'f' | 'i' | 'p'` (but `'p'` not emitted currently;
  point shards default to `i,f` — see `export_map_data.py:-s`).
- `tk`, `ti` — total killed / injured (all occupants).
- `pk`, `pi` — pedestrian killed / injured (also includes cyclists).

So a per-crash breakdown of `driver / passenger / ped+cyclist` killed vs.
injured could be computed at export time from existing crash + occupant
joins, but not from the current map columns alone.

### Hex aggregates (`hex-r{7,8}/YYYY.parquet`)

Pre-aggregated per `(h3, year, cc, mc)` with 4 counts:
`n_fatal`, `n_ped_inj`, `n_other_inj`, `n_pdo`.

"Ped injury" here means the *crash involved* a ped/cyclist injury,
not that a ped-type was the only casualty. This tier currently exists
in the pipeline but renders merged with `n_other_inj` in the UI.

## Plan

### 1. Shared filter state

Introduce a filter object at the page level (`Home.tsx` for embedded;
`CrashMapPage.tsx` for standalone) shaped like:

```ts
type Filter = {
  yearRange: [number, number]
  severities: Set<'f' | 'i' | 'p'>
  victimTypes: Set<'driver' | 'passenger' | 'pedestrian' | 'cyclist'>
  // Optional drill-downs set by brushing:
  focusYear?: number        // from clicking a year-bar
  focusSeverity?: 'f' | 'i' | 'p'  // from clicking a severity segment
}
```

Pass into both `CrashPlot` and `CrashMapSection`; each component reads the
fields relevant to its own rendering.

### 2. Click-to-brush on `CrashPlot`

- **Click a year's stacked bar** (whole column) → set `focusYear=<year>`.
  Plot dims other years; map updates to only that year.
- **Click a severity segment within a bar** → set `focusSeverity=<sev>` and
  `focusYear=<year>`. Plot highlights that single segment; map shows just
  that severity for that year.
- **Click same segment again** → clear focus (same unpin pattern as
  `useLegendPin`).
- **Click the legend item** ("Fatal"/"Injury"/"Prop. Damage") → toggle it
  in `severities` (a cross-plot filter, no focus).

Re-use `pltly`'s plot-click hooks where possible. Focus state should be
driven by `useLegendPin`-like logic so behavior matches
`FatalitiesPerYearPlot` (bold pinned label, click-to-unpin).

### 3. Victim-type filter

Pipeline work:

- Extend `export_map_data.py` hex aggregation to split injury by victim
  type using the existing `occupants` + `pedestrians` joins. Proposed
  columns: `n_driver_inj`, `n_passenger_inj`, `n_ped_inj`, `n_cyclist_inj`
  (plus `n_*_fatal` counterparts where granularity allows).
- Point shards: add `driver_inj`, `passenger_inj`, `ped_inj`, `cyclist_inj`
  boolean flags per crash (or narrow ints). Increases row size ~4 × i8,
  acceptable vs. the 4x PDO multiplier.
- Widen `StackedHex` / `HexRow` types in `useCrashData.ts` + aggregation.

UI work:

- Add a "Victim type" multi-select to the drawer / section toolbox,
  rendered as chips (4 options). Default: all selected.
- When any subset is deselected, apply as a secondary filter after
  severity.
- Re-use `pltly`'s multi-select dropdown if suitable; otherwise a
  chip-group component.

### 4. Outbound signal from map

Future (nice-to-have): click a hex → set `focusSeverity` if one tier
dominates, or zoom + open details on that cell. Not in this pass.

## Minimal first slice

Enough for the forum demo:

1. Shared `yearRange` + `severities` on Home.tsx (already half-done —
   `CrashMapSection` owns its own; lift into a `MapPlotFilterProvider`).
2. Click a **severity segment** on `CrashPlot` → narrows
   `CrashMapSection` to that severity.
3. No victim-type split yet.

Phase 2: victim-type filter + pipeline columns + map tooltip breakdown.

## Open questions

- Does the click-to-brush UX collide with `CrashPlot`'s existing
  Plotly interactions (hover, zoom)? May need `dragmode: false` or
  custom click handler via `onClick` + `event.points`.
- For muni scope, hex aggregates may be too coarse (r7 ≈ 1.2 km); fall
  back to point mode automatically.
- Color consistency check: the CrashPlot "Prop. Damage" color should
  match the pale-yellow in `StackedHexLayer.colors.pdo`.

## Files likely to touch

- `njdot/cli/export_map_data.py` — extra victim-type columns.
- `www/src/map/StackedHexLayer.tsx` — add victim-type fields to
  `StackedHex`; optional extra tiers.
- `www/src/map/useCrashData.ts` — aggregate the new columns.
- `www/src/map/CrashMap.tsx` — tooltip breakdown.
- `www/src/njdot/CrashPlot.tsx` — click-to-brush handler.
- `www/src/routes/Home.tsx` — shared filter state between plot + section.
- `www/src/routes/CrashMapPage.tsx` — victim-type control in drawer.
- `www/src/map/CrashMapSection.tsx` — victim-type control in section
  toolbox.
