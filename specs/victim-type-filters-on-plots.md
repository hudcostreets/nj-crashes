# Victim type filters on NJSP plots

## Context

The NJSP Fatalities per Month and Fatalities by Month plots show total fatalities. The underlying data (from NJSP crash records) includes victim type breakdowns: drivers, passengers, pedestrians, cyclists. Currently only the DOT CrashPlot has stacking/filtering by victim type.

## Goals

Let users filter/stack NJSP monthly fatality plots by victim type, matching the pattern already established in CrashPlot.

## Affected plots

| Plot | Current state | Change |
|------|---------------|--------|
| `FatalitiesPerMonthPlot` | Single "Fatalities" bar + 12mo avg line | Add victim type checkboxes; stack bars by type |
| `FatalitiesByMonthBarsPlot` | Bars per year, single color per year | Add victim type filter; show only selected types' fatalities |
| `FatalitiesPerYearPlot` | Already stacks by type (Driver/Passenger/Pedestrian/Cyclist) | No change needed |
| `HomicidesComparisonPlot` | Compares total traffic deaths vs homicides | Could optionally filter to pedestrian-only deaths |
| `YtdDeathsPlot` | Year-to-date cumulative by year | Could filter by victim type |

## Plan

### 1. Data availability

Check what victim type data is in the NJSP databases:
- `njsp/crashes.db`: has `dk` (drivers killed), `ok` (passengers), `pk` (pedestrians), `bk` (cyclists) per crash
- `year-type-county.db`: already has per-type aggregation (this is what FatalitiesPerYearPlot uses)
- Monthly aggregation: need to check if `monthly` CSV/table has per-type breakdowns

If monthly per-type data doesn't exist, need to either:
- Add it to the NJSP data pipeline (aggregate from crashes.db)
- Query crashes.db directly with monthly GROUP BY

### 2. FatalitiesPerMonthPlot changes

Add a `ControlsGear` panel (matching CrashPlot's pattern) with:
- Victim type checkboxes: Driver, Passenger, Pedestrian, Cyclist
- Stack mode toggle (stacked vs. single filtered total)

When stacking by victim type:
- Each bar segment is a different victim type with distinct color
- 12mo avg line shows total (or per-type lines)
- Colors match the existing `VictimTypeColors` from `njdot/data.ts`

### 3. FatalitiesByMonthBarsPlot changes

This plot shows Jan–Dec bars colored by year. Adding victim type filtering:
- Checkboxes filter which victim types are included in the count
- E.g. checking only "Pedestrian" shows pedestrian fatalities by month across years
- Useful for seeing seasonal patterns in pedestrian deaths specifically

### 4. Shared controls component

Extract a `VictimTypeFilter` component reusable across plots:

```tsx
<VictimTypeFilter
  selected={victimTypes}
  onChange={setVictimTypes}
  colors={VictimTypeColors}
/>
```

### 5. URL state

Persist victim type selection in URL params (via `use-prms`) so filtered views are shareable:
- `?vt=d,p` → show only drivers and pedestrians

## Implementation order

1. Verify data availability in NJSP databases
2. Add monthly per-type aggregation if needed
3. Add controls to FatalitiesPerMonthPlot (most impactful)
4. Add controls to FatalitiesByMonthBarsPlot
5. Optionally add to YtdDeathsPlot and HomicidesComparisonPlot
