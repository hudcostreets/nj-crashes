# Unify SP and DOT crash bar plots into one Plot

First incremental step from `specs/plot-architecture.md` Phase A: collapse `FatalitiesPerYearPlot` (NJSP) and `CrashPlot` (NJDOT) into a single `<CrashPlot>` with a Source toggle.

> **2026-05-10 update**: scope partly superseded by `specs/page-architecture-rethink.md`. The bigger direction is to merge SP fatals + DOT inj/PDO into one *dataset* (no user-facing source toggle), make VT + geo filters page-global, and have tables "brush" with plot selection. This spec still captures the FE refactor inside one plot component, but the "Source toggle" UI may not survive. Re-read both before implementing.

## Final shape (target)

One bar plot. Controls:

- **Source** radio (below plot, like `HomicidesComparisonPlot`): `DOT` / `SP`
- **Time** radio: `By Year` / `By Month` (no any-duration binning yet — punted)
- **Stack-by** radio: `None` / `Severity` / `County` / `Muni` / `Victim type`
- **Measure** radio: `Victims` / `Crashes` / `Per 100K`
- **Severity** checklist (Fatal / Injury / PDO) — hidden + coerced to Fatal when Source=SP
- **County** dropdown
- **Muni** dropdown (when single county selected)
- **Victim type** checklist (Driver / Passenger / Pedestrian / Cyclist) — visible only when SP source (only NJSP has the per-victim-type breakdown)
- **Options** checkboxes: `Stack %`, `12mo avg` (stays gated to By Month)

### Conditional rules

- **Source = SP** ⇒ Severity coerces to Fatal-only (controls hidden). Severity-stack option hidden. Victim-type controls visible.
- **Source = DOT** ⇒ Severity controls visible. Severity-stack option visible. Victim-type controls *would also be visible if NJDOT VT data were exposed in the FE aggregates* — NJDOT raw has Driver/Occupant/Pedestrian/Vehicle tables, but today's `ys`/`yms`/`yccs`/`ymccs`/`ymccmcs` parquets only carry `pk`/`pi` (pedestrian killed/injured), not the Driver/Passenger split. Extending `agg.py` to emit per-VT counts is a separate prerequisite — see "Pipeline prereqs" below.
- **Stack-by = Muni** requires single-county selection (current rule, retained).
- **Measure = Per 100K** divides count by population for the relevant geo at each (year, geo) cell. State-level when no geo filter; county-level when stack-by-county; muni-level when stack-by-muni.

### Measure semantics

| Measure | DOT (each severity) | SP (always fatal) |
|---|---|---|
| Victims | `tk + ti + pdo_count?` → simplest is **tk + ti** (people involved, deaths + injuries); could also offer tk alone | **tk** (NJSP only tracks deaths) |
| Crashes | `n` (number of crash records) | `n` (= number of fatal crashes) |
| Per 100K | `(victims / pop) × 100_000` | `(tk / pop) × 100_000` |

For SP, "Crashes" and "Victims" diverge when a crash has multiple fatalities. Most crashes have `tk=1`, so the two will usually look similar.

Default: **Victims**, year-binned, no stacking. Matches the user's "what I care about" rubric.

## Data wiring

### SP data path

Existing NJSP plots use DuckDB-WASM queries on CSVs:
- `MonthlyCsv` → `monthly.csv`: state + county + (sometimes) muni rows with monthly counts by victim type
- `YtcCsv` → `year-type-county.csv`: year + county + type
- `ProjectedCsv` → projections for current year

For this plot, the SP data is row-shaped as `{ year, month?, cc, mc?, type, n, tk }` — same shape as DOT after grouping. The DuckDB-vs-parquet distinction is wire-level; both can produce row arrays for the trace builder.

**Plan**: introduce a thin `useCrashData({ source, geoLevel, … })` hook that returns a uniform `{ year, month?, cc?, mc?, severity?, victim_type?, n, tk, ti }` row array. Hook internally branches:
- `source='dot'` → existing `useParquet` against the right ys/yms/yccs/ymccs/ymccmcs parquet (depending on geo level)
- `source='sp'` → existing DuckDB queries against NJSP CSVs

Trace-building logic stays the same; consumes the uniform row shape.

### Per-capita data

Use the existing `usePopulation` hook + `getPopulation(lookup, {cc, mc}, year)`. Compute denominator per-trace at the (year, geo) granularity. For stack-percent + per-capita, percent always wins (incompatible measures; disable per-capita when stack-percent is on, or coerce). Easiest UX: stack-percent disables per-capita.

## Implementation plan (incremental — each step a deployable cut)

### Step 1 — `useCrashData` hook abstraction (no UI change)

Refactor today's `CrashPlot` data loading into `useCrashData({ source: 'dot', ... })`. NJSP branch is a stub that throws. Trace-building stays identical. Verifies the abstraction is loadable.

### Step 2 — Source radio + stub SP path

Add the Source radio. SP path: load NJSP `monthly.csv` via DuckDB, project to the uniform row shape. Coerce severity to fatal-only (hide Severity controls). For Stack-by = `Severity`, gracefully fall back to `None` when source=SP. No victim-type stack yet.

### Step 3 — Victim-type controls

When source=SP: show Victim-type checklist (Driver / Passenger / Pedestrian / Cyclist) from the existing NJSP type-stack data. Wire to filter + stack-by.

When source=DOT: same controls, *iff* the pipeline prereq has landed. Otherwise show with reduced granularity (only Pedestrian-vs-Other available from `pk`/`pi`).

#### Pipeline prereq (for full DOT VT support)

Extend `njdot/agg.py` to compute per-victim-type counts from the per-table Drivers / Occupants / Pedestrians tables. Output schema additions:
- `dk` / `di` — drivers killed/injured (need to derive from `Occupants.OccupantType='Driver'` rows)
- `ok` / `oi` — passengers killed/injured (`Occupants.OccupantType='Passenger'`)
- Existing `pk` / `pi` — pedestrians (already present)
- New `bk` / `bi` — bicyclists (need to derive — NJSP has them as a type; NJDOT classifies via pedestrian flags or person-type=bike. TBD where in NJDOT raw)

For AASHTO 2024-2025: `persons.parquet` (from `normalize.py`) has per-person rows with severity rating; can aggregate same way.

This is non-trivial — separate task. Step 3 first ships with VT-controls-only-on-SP and DOT-gets-degraded-granularity, with a TODO comment.

### Step 4 — Measure radio: Victims / Crashes / Per 100K

Replace today's `Crashes / Deaths / Injuries` radio with `Victims / Crashes / Per 100K`. Victims default. Per-capita math.

### Step 5 — Retire the standalone `FatalitiesPerYearPlot`

After above 4 land cleanly, swap the homepage NJSP "Fatalities Per Year" section to use the unified `<CrashPlot source="sp" />`. Keep YTD + HomicidesComparison + ByMonth NJSP plots intact for now (they have other specialty controls). Delete `FatalitiesPerYearPlot` only after homepage references are migrated.

## Out of scope (defer to later phases)

- Any-duration x-bin (awair-style smoothing). Stays {year, month}.
- Cyclic plot (Plot 2 from architecture doc) — separate component, not this one.
- Map / Plot 3.
- `HomicidesComparisonPlot` and `YtdDeathsPlot` consolidation — they have other axes (ratio overlay, cumulative).
- Multi-source overlay (SP + DOT shown together as separate bar groups) — useful but more work, not needed for v1.

## Open questions

- "Per 100K" as a separate measure vs. a "normalize" toggle alongside Victims/Crashes? Separate radio option keeps the y-axis label one-dimensional and matches `path`'s `# / % / vs. '19` pattern.
- For Source=SP with Stack-by=Muni, NJSP's per-muni granularity is uneven (some munis have data only when there's a fatal). Probably fine, but worth a console-warn for sparse cells.
- When Source=SP, the default stack-by should probably switch to `Victim type` (the NJSP signature view) rather than carrying over `Severity` (which is coerced anyway). Or keep memory of last stack-by per source. Lean toward last-per-source.

## Acceptance

After Step 4: the homepage shows one unified `<CrashPlot>` whose **Source: SP** view roughly matches what today's `FatalitiesPerYearPlot` shows for the same geo. After Step 5: `FatalitiesPerYearPlot` deleted from the homepage; unified plot covers both stories.
