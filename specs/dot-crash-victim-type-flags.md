# DOT per-crash victim-type flags

## Goal

Cascade the page-level `t` (NJSP victim type) filter into every NJDOT
surface: **CrashPlot** (Measures=Crashes + Vehicles), **YearStatsSection**,
**NjdotCrashesSection**, and — for free — the **Crash Map**. Today, only
CrashPlot Measure=People honors the filter (via VTC-cell summing over the
selected types × selected conditions); everything else silently ignores
`t`.

## Why

The page-level year range already cascades to every DOT surface, so
having the type filter cascade to only one measure/one plot is
inconsistent. Beyond consistency, the natural questions users ask on
DOT data — "how many crashes involved a pedestrian?", "how many
vehicles were in crashes with a cyclist?" — currently have no answer
on the site.

The map cascade is the biggest UX win: the crash map is effectively
the *spatial view* of the DOT plot+table group, so once the aggregates
carry per-type flags, "show me all pedestrian crashes on the map" is a
top-nav toggle away without changing the map code at all.

## Terminology

For each of the four NJSP victim types (driver / passenger / pedestrian
/ cyclist), we want a boolean per-crash indicator: "did this crash
involve ≥1 person of this type?" We'll call these:

- `has_d` — crash had ≥1 driver-victim
- `has_o` — crash had ≥1 non-driver-occupant (labeled "passenger" in
  UI, matching NJDOT `'o'` code)
- `has_p` — crash had ≥1 pedestrian
- `has_b` — crash had ≥1 cyclist (NJDOT `'b'` code)

A single crash can have multiple flags set — a bike-vs-car collision
usually has `has_d=1` AND `has_b=1`. Filtering by "pedestrian OR cyclist"
is a boolean OR over the flags; the naive sum overcounts crashes that
have both.

## Pipeline changes

### 1. `crashes.parquet` — add flag columns

Join `crashes` with `drivers` / `occupants` / `pedestrians` on the full
PK `(year, cc, mc, case)`. For each crash, set:

```python
has_d = (crash has any driver row with a person present)
has_o = (crash has any occupant row)
has_p = (crash has any pedestrian row)
has_b = (crash has any pedestrian row with pedcode indicating cyclist)
        OR (crash has any non-driver-occupant row with bicycle
            indicator — need to verify NJDOT's raw schema for how
            cyclists are recorded)
```

**Open**: NJDOT records cyclists in the pedestrians table (with a
`bicycle` sub-code) and possibly in the occupants table for
motorcycle-passenger cases. Confirm the exact source before
implementing — mis-encoding cyclists as pedestrians is a common data
issue and will affect the filter's accuracy.

Modify `njdot/crashes.py` to write the four `has_*` columns alongside
the existing PK + geocoding fields. The columns are small (bit-packed
or single bytes each), so total parquet size grows by ~2%.

### 2. Aggregates — rebuild `yms` / `ymccs` / `ymccmcs` with per-flag counts

For each existing (year, [cc, [mc,]] severity) bucket, add four
`n_d`/`n_o`/`n_p`/`n_b` counts alongside the existing `n` (total
crashes). Each is "number of crashes in the bucket where `has_X=1`".

The four counts are not disjoint (a crash with `has_d=1 AND has_p=1`
contributes to both `n_d` and `n_p`). Filtering "crashes involving
pedestrians OR cyclists" needs boolean-OR at query time, which the
per-flag counts alone can't answer exactly. Options:

- **(A) Store all 16 combinations** (`n_dopb=0/1`) — precise for any
  boolean, but 16× the columns.
- **(B) Store just the 4 per-flag counts** and accept
  `count(A ∪ B) = count(A) + count(B)` overcounting when the user
  selects >1 type. Reasonable if most user selections are single
  types (empirical data will confirm).
- **(C) Store the 4 per-flag counts + a small set of common unions**
  (`n_p_or_b` for "vulnerable road users"). Compromise.

**Proposal**: start with (B) — 4 columns, single-type accuracy, and the
plot subtitle already reads well ("pedestrian crashes, 2018–2022")
so multi-type selections are the uncommon case. Revisit if overcounting
turns out to matter for common filter combos.

### 3. Vehicles aggregate columns

Similar treatment for `vehicles` — a vehicle inherits its crash's
`has_*` flags. Rebuild `ymvs` (or the per-vehicle aggregate we use for
CrashPlot Measure=Vehicles) with per-flag `nv_*` counts.

Actually since vehicles-per-crash-type is uniquely defined by
"vehicles in crashes matching filter X", we could compute this at
plot-render time from `ymccs` if we also stored `n_veh_d = sum of
tv over crashes with has_d=1` per bucket. Same 4 columns, same
overcounting caveat.

### 4. D1 re-import

Add the 4 `has_*` (or `n_*`) columns to the D1 schema for the crash
tables that back `NjdotCrashesSection`. Run
`bash api/scripts/d1-import.sh` after the parquet regen.

## UI changes

### CrashPlot

- `Measure=Crashes`: row value becomes `sum(n_X)` over selected types
  (union with overcounting per proposal B).
- `Measure=Vehicles`: same, using vehicle counts.
- `Measure=People`: no change — already filters via VTC cells.
- Subtitle / hover text: prefix "pedestrian" / "pedestrian-or-cyclist"
  when types are narrowed.
- Gear-panel Victim Type checklist: remains locked when `t` is active
  (already implemented for Measure=People — extend to
  Crashes/Vehicles).

### YearStatsSection

- Add a filter to `useYearStats` for the effective type set.
- Total crashes / Fatal crashes / etc. → filtered by summing per-flag
  counts.
- K / SI / MI / OI columns (person-level) → filtered via VTC cells,
  same approach as CrashPlot people measure.

### NjdotCrashesSection

- Add `has_d` / `has_o` / `has_p` / `has_b` columns to the D1 table
  view.
- Worker query gets a new optional `types=dopb` parameter (subset of
  the four flags) — filters `WHERE has_d=1 OR has_p=1` etc.
- Update `useNjdotCrashRows` + `useNjdotCrashesTotal` to pass types.

### Crash Map (cells-api)

The map's cells-api aggregates need the same per-flag counts baked
into each cell (`n_d`/`n_o`/`n_p`/`n_b` alongside `f`/`i`/`o` per
cell). When the user selects types, the worker returns the
sum over selected flag columns instead of the total.

**Big win**: this makes the map filterable by victim type *without any
map component changes* — it just consumes a different aggregate
column per selected set.

## "Third view" framing

Ryan's observation (mid-implementation): the page has been organized
as **plot ⇢ table** pairs, but the map is naturally a *third view* of
the same data + same filters. Once `t` cascades everywhere, the
DOT surface reads as one filter-linked block:

```
NJDOT           Filters: year range + victim types (from top nav)
├─ Map          Spatial view    (cells-api aggregate)
├─ Plot         Temporal view   (CrashPlot)
├─ Stats table  Summary view    (YearStatsSection)
└─ Crash list   Detail view     (NjdotCrashesSection)
```

The current layout has the map at the top of the page and the DOT
plot/tables at the bottom — worth revisiting once the type cascade is
live so the four DOT surfaces sit together and users can see one
"pedestrian crashes in Hudson County 2018–2022" question rendered four
ways.

Analogous restructure applies to NJSP: NJSP fatalities plot + NJSP
recent-fatals table + (future) NJSP fatal-crashes map.

## Phasing

1. **Pipeline schema** — add `has_*` columns to `crashes.parquet`;
   verify cyclist detection is correct across raw sources.
2. **Aggregate rebuild** — regen `yms`/`ymccs`/`ymccmcs` with per-flag
   counts (proposal B: 4 per-flag columns).
3. **CrashPlot wiring** — `Measure=Crashes` + `Measure=Vehicles`
   consume the new counts; extend the "lock" UI already used for
   Measure=People.
4. **D1 tables + worker** — add `has_*` columns and `types=` query
   param.
5. **Table wiring** — `YearStatsSection` + `NjdotCrashesSection` consume
   the type filter.
6. **cells-api** — add per-flag counts to the map aggregate + client
   plumbing.
7. **Layout revisit** — evaluate co-locating the four DOT surfaces
   into one filter-linked block on the homepage. (Optional; may
   defer.)

Phases 1-3 could ship as one PR; 4-6 as another. Phase 7 is a
separate design conversation.

## Open questions

- Cyclist encoding in NJDOT raw — pedestrians table vs elsewhere? See
  Phase 1 note.
- Include an `n_u` (Unknown victim type) column for parity? NJDOT
  raw has this bucket; we currently drop it when mapping to NJSP's
  4-type set. If someone wants to see "crashes with only unknown-type
  victims" on the map, this helps — otherwise omit.
- How does the type filter interact with the NJDOT Condition
  checkboxes (KABCO)? For measure=Crashes, KABCO doesn't apply
  (crash-level, not person-level). Should the checkbox row still
  render when a `t` filter is active, or should we hide it? Probably
  hide when `Measure=Crashes` regardless of `t`, but confirm.
