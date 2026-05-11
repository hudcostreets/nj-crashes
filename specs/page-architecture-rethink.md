# Homepage rearchitecture: hide SP/DOT distinction, brush tables, global filters

Captures a substantial rethink of the homepage layout and information architecture, articulated 2026-05-10. Supersedes parts of `specs/unify-sp-dot-bar-plot.md` (specifically the user-facing "Source toggle" idea).

## Premise

Today's homepage is a stack of sections, each presenting one viz with its own title, controls, and data source. Users see "NJSP" and "NJDOT" labels and have to know which is which. Multiple sections show overlapping data with subtle differences. The architectural seams between data sources are visible in the UI.

Goal: a homepage where the SP-vs-DOT distinction is *not user-facing* (revealed only in tooltips / info bubbles for those who care), where filters affect everything coherently, and where tables are list-views of what plots are highlighting rather than independent sections.

## Target layout

(top → bottom)

1. **Map** — at or near the top. Crash points + optional choropleth overlay. (Currently mid-page.)
2. **Single unified plot** — bar plot defaulting to *fatal crashes incl. projections* (the most-loaded story). Sub-controls inline.
3. **Crash list** — "Recent crashes matching the current selection." Plays the role of today's Recent Fatal Crashes table, but **brushed** by plot selection: if user pins fatal+pedestrian+Hudson on the plot, the list filters to those. Not a separately-titled section; visually integrated below the plot.
4. **`/h11n` link + small accessory plots** — `YTD Deaths`, `Homicides Comparison`, `By Month` retained but compact. Each respects global VT/geo filters (e.g., `YTD Deaths` filtered to pedestrians via the global VT toolbar).
5. **Annual Statistics (NJDOT)** table — stays at the bottom as a comprehensive reference table.

## Information architecture changes

### Global filter toolbar

VT + geo controls become **page-level**, not per-plot. Implementation:
- Floating toolbar at top of viewport (sticky on scroll), or scroll-into-view-then-hide pattern. Tailwind/CSS-only.
- Per-plot controls (stack-by, granularity, etc.) stay local. Filters that affect *what's plotted* become global.
- Hook: `useGlobalFilters()` already half-exists as `useGeoFilter()`; extend to VT.

### Merged dataset (one underlying source)

Combine into a single "crashes" dataset:
- **Fatals**: NJSP (canonical) — 2001 to present, daily-refreshed.
- **Injuries + PDO**: NJDOT (per-table 2001-2022, AASHTO 2023+, plus the SP-supplement we already do for 2025 fatals).
- **De-duplication**: where NJSP and NJDOT both have a fatal, use NJSP's. Already 95%+ matched via `three_way_fatals.parquet`.

Frontend reads one canonical dataset; doesn't ever ask "which source." Source info still surfaces in:
- Per-crash detail-page metadata
- The `/harmonization` page's existing source-breakdown view
- Tooltip on the unified plot's title (info-bubble)

This drops the user-facing Source toggle from the unify spec.

### Brushed crash list

Plot selection → list filter. Two interaction patterns:
- **Pin on legend** (e.g., pin "Pedestrian" in VT stack): list filters to ped fatals
- **Click a bar** (e.g., 2024 bar): list filters to 2024 crashes in current geo

Reuses the cross-plot brushing context from `specs/plot-architecture.md` (#5).

### Projections (SP-only concept)

"Projected" is meaningful only for fatals (NJSP YTD-projection of current-year total). When the unified plot's Y is fatal-deaths, show projections; when it's injuries/PDO, hide. Projections live in `monthly.csv` already.

## Implementation order (incremental)

Each step is a deployable cut; no big-bang rewrite.

### Phase 0 — small wins immediately ahead

- **Annual Statistics table extends through 2025** — currently stuck at 2023. The `/njdot/year-stats` worker endpoint reads D1 which has per-table data only. Need to also ingest AASHTO-supplemented 2024-2025 totals into D1. (User-visible bug captured in this rethink.)
- **YTD Deaths legend** — start scrolled to current year (or `traceorder: 'reversed'`). ✓ shipped.
- **Homicides plot — remove SP/DOT toggle**, standardize on SP. ✓ shipped.
- **AASHTO 2025 ingestion-lag supplement** — landed in earlier commits.

### Phase 1 — pipeline prereqs

- Extend `agg.py` to emit per-VT counts (`dk`/`di`/`ok`/`oi`/`pk`/`pi`/`bk`/`bi`). NJSP already has these from `monthly.csv`; NJDOT needs derivation from per-table Drivers/Occupants/Pedestrians or AASHTO `persons.parquet`. Single ys/yms/yccs/ymccs/ymccmcs schema extension.
- Produce a `merged_crashes.parquet` that fuses NJSP fatals + NJDOT inj/PDO with de-duplication via `three_way_fatals.parquet` matches. This becomes the single canonical FE dataset.

### Phase 2 — FE: global filter toolbar

- Move VT controls out of `FatalitiesPerYearPlot` and `FatalitiesByMonthBarsPlot` into a page-level toolbar.
- Move geo controls (already partly factored as `useGeoFilter`) into the same toolbar.
- Each plot reads `useVtFilter()` + `useGeoFilter()` + applies internally.

### Phase 3 — FE: brushed crash list

- Wire the existing `useResetSolo` / `useTraceLegend` / pinning machinery so that pinned series + selected bars feed a "current selection" context.
- `<RecentFatalCrashes>` table subscribes; query becomes `WHERE year IN <pinned> AND vt IN <pinned> AND geo ...`.

### Phase 4 — FE: unified plot

- Rebuild today's `CrashPlot` (NJDOT) + `FatalitiesPerYearPlot` (NJSP) as one component reading the merged dataset. Default Y=fatal-deaths-with-projections. (See `specs/unify-sp-dot-bar-plot.md` for the within-plot mechanics.)

### Phase 5 — FE: page reorder

- Map up top. Annual Stats stays at bottom. Compact the accessory plots.

## What goes away

- "NJSP" and "NJDOT" labels on the homepage (with the exception of the bottom Annual Statistics table title, which is honest about its source).
- Today's "Recent Fatal Crashes" section title — list becomes implicit below the plot.
- The Source toggle from `specs/unify-sp-dot-bar-plot.md`.

## What stays

- `/harmonization` page — explicitly *about* the source-distinction story, valuable for the data-curious.
- The Annual Statistics table (NJDOT-comprehensive reference) at the bottom.
- Per-crash detail pages with full source provenance.

## Open questions

- **Map at top or just *near* top?** Map is heavy (parquet → hex picker → render). May want a smaller "preview" map at top that expands to full crash map below, vs. one big map dominating top-of-page.
- **How aggressively to merge NJSP + NJDOT for non-fatals?** NJSP doesn't have injuries/PDO. Merging means "NJSP for fatals, NJDOT for non-fatals" — clean. But the *graphs* showing "all severities" would have NJSP fatals + NJDOT inj/PDO on the same bars. Conceptually fine, but the 2008-2022 window where DOTr's broad-fatal-flag differs from NJSP's strict fatals would surface as an apparent jump if not careful.
- **Page-global filters: persist across navigation?** Probably yes (URL state, like `?vt=pedestrian&cc=9`). Aligns with existing geo URL persistence.
- **Brush latency**: a click on a bar should filter the list quickly. Worker `/njsp/crashes` is the bottleneck (D1 latency). Acceptable for v1; may need client-side caching of recent-crashes for the brush case.

## Related specs

- `specs/plot-architecture.md` — the longer-horizon 3-core-plots vision
- `specs/unify-sp-dot-bar-plot.md` — within-plot mechanics, partly superseded by this doc's "no user-facing source toggle" decision
- `~/c/hccs/hbt/specs/animated-map.md` — parallel animation primitive (relevant when Phase 5's map gets the time-window slider)
