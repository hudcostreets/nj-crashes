# Plot architecture: factoring the space of "all possible plots"

Cross-project design memo capturing how the plot surface in `crashes` could evolve toward parity with `path` / `awair` / `hbt`, with primitives that all four projects can share via `pltly`. **Not** a concrete implementation plan — this is the longer-horizon "where are we going" doc to refer back to as we land smaller pieces.

## Why this doc

`crashes` has the most catching up to do across these projects. Today's plot surface is a constellation of dedicated components (`CrashPlot`, `FatalitiesPerYearPlot`, `YtdDeathsPlot`, `HomicidesComparisonPlot`, `FatalitiesByMonthBarsPlot`, …) with overlapping concerns and inconsistent control vocabularies. The data behind them is unified enough that 3-4 well-factored plots should cover everything, with a shared control vocabulary.

## The "axes of variation" in this data

Seven independent dimensions appear in our plot surface:

- **WHEN** — year / month / day-of-week / hour-of-day · time-range × bin-size
- **WHERE** — state / county / muni · point or polygon
- **WHO** — driver / passenger / pedestrian / cyclist (victim type)
- **WHAT** — severity (fatal/injury/PDO)
- **MEASURE** — count, per-100K, %, vs-baseline
- **SOURCE** — NJSP / DOTr / DOTa
- **SHAPE** — stacked-bar, grouped-bar, line, smoothed-line+band, area

A single "plot designer" widget exposing all seven converges on plotly-the-tool — too generic. The opinionated middle: **3 plots that each bake in one axis, leaving the others flexible**, plus the existing `/harmonization` as a 4th specialty.

## Proposal: 3 core plots + 1 specialty

### Plot 1: **Time series** (subsumes `CrashPlot`, `FatalitiesPerYearPlot`, `YtdDeathsPlot`, `HomicidesComparisonPlot`)

Baked: **x = time**.

Controls:
- **Granularity**: year / month (week / day later if useful)
- **Stack-by**: severity / county / muni / victim-type / source (auto-line-vs-bar when series count > N)
- **Measure**: count (victims default) / per-100K / % stack
- **Severity / geo / source** filters
- **Smoothing**: duration; renders rolling-mean + ±σ band + faint raw (awair pattern; replaces binary "12mo avg")

NJSP+NJDOT unification: with 2024-2025 supplement landed, DOTa-strict matches NJSP through 2024 and supplements 2025. The two separate plots collapse into one with a **source** toggle (SP coerces severity to fatal-only). NJSP's victim-type stack folds in as one stack-by option.

### Plot 2: **Cyclic / collapsed-time** (subsumes `FatalitiesByMonthBarsPlot`)

Baked: **x = within-cycle bin** (month-of-year / day-of-week / hour-of-day).

Controls:
- **Cycle**: which time dimension collapses (months across years; DOWs across months; hours across all days)
- **Stack-by**: year (default) / severity / victim-type / county
- **Geo / severity / source** filters
- **Smoothing** on the cyclic axis (rolling-by-N-bins, with wraparound for DOW/hour)

New stories: hourly distribution of pedestrian fatals, DOW patterns by severity, monthly seasonality of alcohol-involved crashes. All in NJDOT data already.

### Plot 3: **Spatial** (crash map + choropleth + animation)

Baked: **x = lat/lon** (point) or polygon (county / muni).

Controls:
- **Time window**: slider with play-button (animation), or fixed range
- **Aggregation level**: points / muni-choropleth / county-choropleth
- **Measure**: count / per-100K / per-mile-of-road
- **Severity / source** filters

Animation cycles year (or year-month) — same generalization spec'd for `hbt`. Generalizes the existing crash map.

### Plot 4 (specialty): `/harmonization` — already shipped

Doesn't fit Plot 1's mold (categorical source-set decomposition). Keep as a dedicated page.

## Cross-cutting primitives (candidates for `pltly`)

These show up in every project:

1. **`<TimeBins>`** — granularity dropdown + auto-mode (`awair`'s `1m (720 × 2px)`)
2. **`<SmoothingControl>`** — duration → rolling-mean trace + ±σ band + faint-raw trace; replaces hardcoded "12mo avg"
3. **`<MeasureToggle>`** — count / rate / % / vs-baseline (`hbt`'s `vs. '19`)
4. **`<StackByDropdown>`** — auto-switch to lines when series count > N
5. **Cross-plot brushing** — Provider that tracks "currently pinned series" (e.g. `cc=9 Hudson`); each plot subscribes via hook and fades non-pinned. Generalization of the existing `ResetSoloProvider`/`useResetSolo` from single-plot to multi-plot. `path`'s legend pinning is the model.
6. **`<TimeWindowAnimator>`** — slider + play button; emits an active range

If 1-3 land in `pltly`, all four projects benefit at once.

## Recommended ordering (incremental steps, not big-bang)

Phase A — small wins inside crashes, primitive shape clarifying:

1. **Unify SP and DOT bar plots** (Plot 1 first incarnation). Add source toggle (SP/DOT), victim-type filter, y-metric (#victims / #crashes / per-capita), Stack-by-County so 21-line per-county is one toggle away. Defer animation, smoothing, cyclic plot, animation.
2. **Per-capita lands as a measure**, not a new component. ✓ falls out of (1).
3. **Counties stack-by** auto-switches to lines (bake "many series → line" heuristic).

Phase B — pltly primitives:

4. **`<SmoothingControl>` in pltly**, retire the binary `12mo avg` toggle. Lands in `awair` and `crashes` simultaneously.
5. **Cross-plot brushing context**: pinning a county on Plot 1 highlights it on Plot 3 (map) too. High leverage; small surface.

Phase C — bigger swings:

6. **Plot 2 (cyclic)** — generalize FatalitiesByMonthBars to DOW + hour-of-day. NJDOT has crash time; new stories unlock.
7. **Plot 3 animation** — see `hbt`'s `animated-map.md` spec (parallel). Identical primitive.

Phases A and B can interleave with feature work; C is meatier and probably wants a focused chunk.

## Out of scope here

- Wholesale rewrite or naming of existing components — incremental refactoring per step.
- Building the full "plot designer" widget — explicitly *not* the goal; we want 3 opinionated plots.
- Map-tiling work or alternative basemaps — separate concern.

## Related

- `~/c/hccs/hbt/specs/animated-map.md` (parallel spec for hbt's animated bubble map; Plot 3 animation primitive should serve both).
- `project_njdot_fatality_definitions.md` memory — strict-vs-broad fatal definition, relevant whenever Plot 1's severity filter is involved.
