# NJDOT victim and vehicle plots

## Context

The homepage currently has a `CrashPlot` (stacked bar chart of crash *counts* over time) followed by a `YearStatsSection` table showing *victim* counts by severity. This is confusing: the plot counts crashes, the table counts victims (drivers + passengers + pedestrians + cyclists), and the two are not directly comparable.

There is also a `VictimSeverityPlot` (bubble chart, currently commented out in `Home.tsx`) that shows victim counts by type and severity, but as a bubble scatter rather than the stacked bar format users are familiar with from `CrashPlot`.

## Goals

1. Add a **Victim Plot**: stacked bar chart of victim counts over time (matching `CrashPlot` UX), stackable by severity and victim type.
2. Add a **Vehicle Plot**: stacked bar chart of vehicles involved in crashes over time, with vehicle type breakdown.
3. Adopt a **plot + expandable table** pattern: each plot followed by a collapsible `<details>` element showing the underlying data in tabular form.

## 1. Victim Plot (`VictimPlot`)

### Data source

The `cmyc` table in `cmymc.db` already has per-year, per-condition victim counts broken out by type:

```
(cc, mc, y, condition, drivers, passengers, pedestrians, cyclists, num_crashes)
```

The existing `/njdot/victim-severity` endpoint returns this data (aggregated to the appropriate `yc`/`cyc`/`cmyc` table based on `cc`/`mc` params). It already returns everything needed for a stacked bar chart.

### Component

Create `www/src/njdot/VictimPlot.tsx` as a **new component** (not an extension of `CrashPlot`). Rationale: `CrashPlot` loads parquet files (`yms.parquet`, `ymccs.parquet`) from static data and counts crashes. `VictimPlot` fetches from the D1 API (like the existing `VictimSeverityPlot`) and counts people. The data shapes and sources are different enough that sharing a component would add more complexity than it saves.

However, `VictimPlot` should reuse the same sub-components and patterns:
- `ControlsGear` for settings drawer
- `Checklist` for severity/type toggles
- `Radios` for stack-by selection
- `CountyDropdown` for county filtering
- `PlotWrapper` with `useSoloTrace` for legend click behavior
- `usePlotColors` / `useTheme` for dark mode

### Stacking/filtering options

**Stack By** (radio):
- None (single "Total victims" bar)
- Severity (Fatal / Serious Injury / Minor Injury / Possible Injury)
- Victim Type (Driver / Passenger / Pedestrian / Cyclist)

**Severity filter** (checklist): Fatal, Serious Injury, Minor Injury, Possible Injury. Exclude condition 5 (No Injury/PDO) by default since those are not really "victims."

**Victim Type filter** (checklist): Driver, Passenger, Pedestrian, Cyclist.

**Options**: Stack %, 12mo avg (when monthly view is available).

**Time granularity**: Start with yearly only. The current API returns data grouped by `(y, condition)` without month granularity. Monthly victim data would require either a new API endpoint or a new aggregation table (`cmymc` with month). This can be deferred; note it as a future enhancement.

### Colors

- Severity colors: reuse `SeverityColors` from `data.ts` (same as `CrashPlot`)
- Victim type colors: reuse the colors already defined in `VictimSeverityPlot.tsx`:
  - Driver: `#636EFA`, Passenger: `#00CC96`, Pedestrian: `#AB63FA`, Cyclist: `#FFA15A`
- Extract these into `data.ts` as `VictimTypeColors` so both plots can share them.

### Placement on page

Insert between the existing `CrashPlot` and the "Annual Statistics" `<h2>`:

```
CrashPlot (crashes over time)
VictimPlot (victims over time)      <-- NEW
Annual Statistics table
```

This makes the narrative flow: crashes, then victims within those crashes, then the raw numbers table.

## 2. Vehicle Plot (`VehiclePlot`)

### Data availability

The existing `vehicles` D1 database has per-vehicle rows with columns `(crash_id, damage, damage_loc, impact_loc, departure, type)`. However:
- There is **no pre-aggregated vehicle-type-by-year table** analogous to `cmyc`.
- Querying raw vehicle rows and aggregating client-side is not feasible (millions of rows).
- A new aggregation is needed.

### New aggregation: `vyc` table

Add a new table to `cmymc.db` (or a new DB) with yearly vehicle type counts:

```sql
CREATE TABLE vyc (
    y INTEGER,
    type INTEGER,
    count INTEGER,
    PRIMARY KEY (y, type)
);
-- Optionally county-level: cvyc (cc, y, type, count)
-- Optionally muni-level: cmvyc (cc, mc, y, type, count)
```

**Vehicle type codes** (from NJDOT `type` field): the exact mapping needs to be confirmed from `njdot/data/` parquet schemas, but typically includes categories like passenger car, SUV, pickup, van, bus, motorcycle, bicycle, truck/tractor-trailer, etc.

### New API endpoint

```
GET /njdot/vehicle-stats?cc=&mc=
```

Returns `[{ y, type, count }, ...]` from the appropriate `vyc`/`cvyc`/`cmvyc` table.

### Component

Create `www/src/njdot/VehiclePlot.tsx`:

**Stack By**:
- None (total vehicles per year)
- Vehicle Type (passenger car, SUV, motorcycle, truck, bus, etc.)

**Time granularity**: Yearly only (same constraint as victim plot; monthly would need further aggregation).

### Placement

After `VictimPlot`, before the Annual Statistics table:

```
CrashPlot
VictimPlot
VehiclePlot                         <-- NEW
Annual Statistics table
```

### Implementation priority

Vehicle plot is lower priority than victim plot. The victim data already exists and just needs a new visualization. The vehicle plot requires:
1. Understanding vehicle type codes (check parquet schema)
2. Building the aggregation in the Python pipeline
3. Adding the table to `cmymc.db` (or a new DB)
4. Adding the API endpoint
5. Building the component

Consider deferring to a follow-up.

## 3. Plot + expandable table pattern

### Design

Each plot gets a `<details>` element immediately below it, containing a table of the plotted data:

```html
<PlotContainer>
  <VictimPlot />
</PlotContainer>
<details>
  <summary>View data table</summary>
  <table>...</table>
</details>
```

### Behavior

- Collapsed by default (plot is the primary view)
- Table shows the same data the plot visualizes, reflecting current filter/stack state
- When filters change, table updates to match
- Table is sortable by column (click header to toggle asc/desc)
- Rows correspond to the plot's x-axis (years or months)
- Columns correspond to the active stacking dimension

### Shared component

Create `www/src/components/PlotDataTable.tsx`:

```tsx
type PlotDataTableProps = {
    columns: { key: string, label: string }[]
    rows: Record<string, string | number>[]
    defaultSort?: { key: string, dir: 'asc' | 'desc' }
    caption?: string
}
```

This is a generic sorted table that any plot can use. Wire it into `CrashPlot`, `VictimPlot`, and eventually `VehiclePlot`.

### Reference

The [awair project][awair] (`/Users/ryan/c/awair/www`) has an example of plots with synced pageable tables. Adapt the pattern but use `<details>` for progressive disclosure rather than always-visible tables.

[awair]: /Users/ryan/c/awair/www

## 4. Data constants to extract/share

Move these from component files into `www/src/njdot/data.ts`:

- **Victim type definitions**: `VICTIM_TYPES` array with `{ key, label, color }` (currently defined inline in `VictimSeverityPlot.tsx`)
- **Condition labels**: `CONDITIONS` array (currently in `VictimSeverityPlot.tsx`, partially duplicated in `use-year-stats.ts`)

This avoids duplication between `VictimSeverityPlot`, `VictimPlot`, and `PlotDataTable`.

## 5. Retiring `VictimSeverityPlot`

The bubble plot (`VictimSeverityPlot.tsx`) is currently commented out in `Home.tsx`. Once `VictimPlot` exists and covers the same data in a more useful format (stacked bars with controls), consider removing `VictimSeverityPlot` entirely, or keeping it as an alternative view toggled via a control.

## Implementation order

1. **Extract shared constants** into `data.ts` (victim types, condition labels/colors)
2. **Build `VictimPlot`** using existing `/njdot/victim-severity` endpoint
3. **Add `VictimPlot` to `Home.tsx`** between `CrashPlot` and Annual Statistics
4. **Build `PlotDataTable`** component
5. **Wire `<details>` tables** into `VictimPlot`, then `CrashPlot`
6. **Vehicle aggregation pipeline** (Python: aggregate vehicle types by year/county/muni, add to `cmymc.db`)
7. **Vehicle API endpoint** (`/njdot/vehicle-stats`)
8. **Build `VehiclePlot`** and add to page

Steps 1-5 can ship as one PR. Steps 6-8 are a follow-up.

## Open questions

- **Monthly granularity for victims**: The `cmyc` table only has yearly data. Adding a month dimension would mean a new table (`cmymc` with `m` column) and modifying the Python aggregation. Worth doing, or is yearly sufficient for now?
- **Vehicle type grouping**: Raw vehicle type codes may have 20+ categories. Should we group into ~6-8 buckets (passenger car, SUV/truck, motorcycle, bicycle, bus, commercial truck, other)?
- **No Injury (condition 5)**: Currently excluded from victim plots. Should it be available as an opt-in toggle? These are people involved in crashes who were not injured, which could be interesting for showing total people affected.
- **Stacking by both dimensions**: Should the victim plot support e.g. "stack by victim type, filter to fatal only"? The current design has stack-by as a radio (one dimension at a time) with the other dimension as a filter checklist, which covers this use case.
