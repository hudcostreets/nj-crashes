# DOT table vehicle statistics

## Context

The Annual Statistics (NJ DOT) table currently shows crash counts, injuries, and fatalities by year and severity. The underlying data includes rich vehicle-level information (totaled vehicles, hit-and-run, DUI, etc.) that would add valuable context.

## Goals

Add vehicle and circumstance statistics to the DOT annual stats table and/or crash detail rows.

## Available fields

From the NJDOT vehicles/crashes data (check `njdot/data/` parquet schemas):

### Vehicle-level
- **Damage extent**: totaled, disabled, functional, no damage
- **Hit and run**: driver left scene
- **Towed**: vehicle towed from scene
- **Contributing factors**: speeding, DUI, distracted, etc.

### Crash-level
- **Alcohol involved**: any driver BAC > 0
- **Road conditions**: wet, icy, etc.
- **Light conditions**: dark, dawn, dusk
- **Weather**: rain, snow, fog

## Plan

### 1. Extend aggregation parquets

The `yms.parquet` / `ymccs.parquet` files (used by CrashPlot) currently aggregate `n`, `tk`, `ti`, `pk`, `pi`, `tv`, and victim-type-condition matrix columns. Add:

```python
# New columns in yms/ymccs aggregation
hr: int      # hit-and-run crash count
alc: int     # alcohol-involved crash count
spd: int     # speed-related crash count
tot: int     # crashes with ≥1 totaled vehicle
```

This requires joining vehicles table during aggregation in the Python pipeline.

### 2. Year stats table columns

Add optional columns to the Annual Statistics table (toggleable to avoid clutter):

| Column | Description |
|--------|-------------|
| H&R | Hit-and-run crashes |
| Alcohol | Alcohol-involved |
| Speed | Speed-related |
| Totaled | Crashes with totaled vehicles |

### 3. Crash detail enrichment

In the NJDOT Crash Details table, add per-row indicators:
- H&R flag icon
- Alcohol flag
- Vehicle count + damage summary (e.g. "3 veh, 1 totaled")

This data is available via the existing `crash-vehicles.ts` on-demand fetch pattern (already loads vehicle details when expanding a crash row).

### 4. CrashPlot stacking option

Add "Contributing Factor" or "Circumstance" as a stacking dimension in CrashPlot, showing e.g. alcohol vs. speed vs. other over time.

## Implementation order

1. Check available fields in parquet schemas (`pqs njdot/data/crashes.parquet`, etc.)
2. Add columns to Python aggregation pipeline
3. Regenerate `yms.parquet` / `ymccs.parquet`
4. Add columns to year stats table
5. Add indicators to crash detail rows
