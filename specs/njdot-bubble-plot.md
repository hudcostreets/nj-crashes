# NJDOT Severity × Victim Type Bubble Plot

## Concept

A scatter/bubble plot showing crash data across multiple dimensions simultaneously:
- **X-axis**: Year (2001–2023)
- **Y-axis**: Severity level (fatal, serious injury, minor injury, possible injury)
- **Bubble size**: Area-proportional to victim count
- **Color**: Victim type (driver, passenger, pedestrian, cyclist)

This visualization works well at all geo levels — even small municipalities have enough NJDOT data (all crashes, not just fatals) to show meaningful patterns.

## Data source

The `cmyc` table in `cmymc.db` (already deployed to D1) has exactly the right structure:

```
cc, mc, y, condition, drivers, passengers, pedestrians, cyclists, num_crashes
```

For the frontend parquet path: `ymccmcs/{cc}.parquet` (per-county muni-level files already exist).

### Condition codes
1. Fatal (killed)
2. Serious injury
3. Minor injury
4. Possible/other injury
5. No injury / property damage only

Condition 5 (PDO) has zero victims by definition but many crashes. Options:
- Exclude condition 5 from victim-type bubbles (makes sense — no victims)
- Show a separate "crashes" bubble for condition 5 in a distinct style (gray, outline-only?)
- Or include a "Crashes (PDO)" row on the y-axis

## Layout

```
              2001  2002  2003  ...  2023
Fatal         ●     ●     ●         ●      (small bubbles, 4 colors each)
Serious Inj   ●●    ●●    ●●        ●●     (medium bubbles)
Minor Inj     ●●●   ●●●   ●●●       ●●●    (larger bubbles)
Possible Inj  ⬤⬤⬤   ⬤⬤⬤   ⬤⬤⬤       ⬤⬤⬤    (largest bubbles)
```

Each year × severity cell has up to 4 overlapping/adjacent bubbles (one per victim type). Since the scale varies dramatically (fatal: 1-10, possible injury: 100-2000 per muni/year), bubble sizing needs thought.

### Sizing options

1. **Log scale bubble area**: `radius = k * sqrt(log(count + 1))` — prevents large counts from dominating
2. **Per-severity normalization**: Each severity row has its own scale — shows relative changes within severity, not across
3. **Jittered positions**: Slight y-offset per victim type to prevent overlap, or side-by-side within each cell

### Recommended approach

Use **jittered y-positions** within each severity band:
- Y-axis has 4 severity bands (1–4), each subdivided into 4 victim type lanes
- Within each lane, bubble size is area-proportional to count
- This avoids overlap while keeping the grid structure readable

## Color palette

Match existing `VictimTypeColors` from `njdot/data.ts` (or define new if not suitable):
- Driver: blue
- Passenger: orange
- Pedestrian: red
- Cyclist: green

## Interactions

- **Hover**: Show exact count, year, severity, type
- **Legend click**: Solo/unsolo victim types (using `useSoloTrace` from pltly)
- **Geo filtering**: Responds to `cc`/`mc` from `useGeoFilter()`
- **Controls** (ControlsGear):
  - Toggle victim types (checkboxes)
  - Toggle whether to show PDO/condition-5 crashes
  - Linear vs. log bubble sizing

## Data flow

### Option A: D1 API (preferred for muni pages)
Add endpoint: `GET /njdot/victim-severity?cc=&mc=`
```sql
SELECT y, condition, drivers, passengers, pedestrians, cyclists, num_crashes
FROM cmyc WHERE cc = ?1 AND mc = ?2
ORDER BY y, condition
```

### Option B: Parquet (for statewide/county)
Use existing `ymccmcs/{cc}.parquet` files for county-specific data, or `yms.parquet` for statewide.

### Recommendation
Use the D1 API — the `cmyc` table is already there, and the query is simple. The data volume is small (≈23 years × 5 conditions × 4 types = ~460 values per municipality).

## Component

New file: `www/src/njdot/VictimSeverityPlot.tsx`

Place on the page after CrashPlot, before the tables. This plot complements CrashPlot (which shows crash counts over time stacked by severity or county) by showing the victim breakdown within each severity.

## Implementation order

1. Add D1 API endpoint `/njdot/victim-severity` (or reuse `/njdot/year-stats` with additional columns)
2. Build `VictimSeverityPlot` component with Plotly scatter mode
3. Wire into `Home.tsx` with geo filtering
4. Add controls (victim type toggles, sizing options)
