# Vehicle facets in CrashPlot

## Motivation

The `measure=Vehicles` axis of CrashPlot currently has no meaningful stack-by
choice. Crash-level Severity is misleading (a "Fatal" stack would count
vehicles that *participated in* fatal crashes — including the undamaged ones
— not vehicles that were totaled). What we actually want for Vehicles:

1. **Damage / Disposition facet** — analogous to person-level `Condition`,
   one bar segment per damage tier (None / Minor / Moderate / Disabling).
2. **Make facet** — per-year counts by Honda / Toyota / Ford / … with a
   Top-N + Other bucket (~215K free-text uniques, dominated by ~30 real
   manufacturers).
3. **Model facet** — drill-down within Make.
4. **Maker → fatalities attribution** (longer-term, separate page) — "this
   Make was driven in N fatal crashes / struck N pedestrians."

## Data sources

### Per-vehicle columns in `njdot/data/vehicles.parquet` (legacy)

| Column      | Schema     | NJTR-1 source              | Coverage             |
|-------------|------------|----------------------------|----------------------|
| `damage`    | Int8 (1-4) | "Extent of Damage"         | ~24% (9.2M / 12.3M NA pre-2019) |
| `departure` | Int8 (1-6) | "Driven/Left/Towed"        | ~99% (very low NA)   |
| `make`      | string     | Free text                  | ~99% (215K uniques)  |
| `model`     | string     | Free text                  | ~99%, even noisier   |
| `vy`        | Int16      | Vehicle Year               | varies               |
| `type`      | Int8       | Vehicle Type code          | varies               |

### Code mappings (`njdot/codes.py`)

`extent_of_damage` (column `damage`):
```
1 = None
2 = Minor       (does not affect operation)
3 = Moderate    (Functional - affects operation; not disabling)
4 = Disabling   (must be towed/carried; cannot depart under own power)
```

`vehicle_departure` (column `departure`):
```
1 = Driven
2 = Left at Scene
3 = Towed Disabled
4 = Towed Impounded
5 = Towed Disabled & Impounded
6 = Towed (legacy <2017, details not specified)
```

### AASHTO gap (2024-2025)

There is **no AASHTO vehicles supplement** (see `njdot/cmymc.py` head
comment). For 2024+ we have *no* per-vehicle damage / disposition / make /
model. Three options:

- **A. Build `njdot/aashto/to_njdot_vehicles.py`** — mirror
  `to_njdot_persons.py` for AASHTO vehicles, normalize to the legacy schema
  (`damage`, `departure`, `make`, `model`). Same daily-CI hookup. Largest
  effort but unblocks all vehicle facets for 2024+.
- **B. Accept "no data" gracefully for AASHTO years** — leave the new agg
  columns as zero/null for 2024+. UI shows a thin/empty bar for those years
  on Vehicle facets. Lowest cost.
- **C. Defer (do nothing)** — UI gates the Vehicle facets to 2001-2023
  only, with a tooltip pointing at option A.

Recommendation: **B for the first pass**, A as a follow-up.

## Proposed aggregations

Add new columns to `yms` / `yccs` / `ymccs` / `ymccmcs` (extending
`agg.py`):

### Damage facet (5 cols)

| Column | Meaning                       |
|--------|-------------------------------|
| `vdn`  | Vehicles with damage = None    (code 1)  |
| `vdm`  | … = Minor                      (code 2)  |
| `vdo`  | … = Moderate                   (code 3)  |
| `vdx`  | … = Disabling                  (code 4)  |
| `vdu`  | … = Unknown / NA / 0 / 98 / 99           |

`tv` (existing total) = `vdn + vdm + vdo + vdx + vdu`.

Naming: `vd` prefix avoids collision with VTC drivers cells (`df`, `ds`,
`dm`, `dp`, `dn`).

### Make facet — separate aggregate file `ymak.parquet`

Per (year, cc, mc, make-or-other) row, count of vehicles. Top-K rollup
strategy:

- Compute global make popularity (across all years).
- Keep top **K=30** makes verbatim; collapse the rest to `make='OTHER'`.
- Strip free-text noise: title-case, drop blank, normalize common typos
  ("CHEVY" → "CHEVROLET", "VW" → "VOLKSWAGEN", "MERCEDES BENZ" /
  "MERCEDES-BENZ" → unified).

Why a separate file: high cardinality + UI rarely needs it co-loaded with
the main aggregates. Loaded only when the user selects the Make facet.

### Model facet — defer

Cardinality is even worse, and useful only after Make is filtered. Add as a
secondary aggregate (`ymakmodel.parquet`) when the Make facet ships and we
see real usage.

### Maker → fatalities attribution — separate page (`/vehicles`?)

Distinct page, not part of the CrashPlot bars. Joins:
`occupants` → `vehicles` → `crashes` (filter to severity='f'), aggregate by
`make`. Shows "drivers killed in <Make> / pedestrians killed by <Make> /
total fatal crashes involving <Make>" per year.

Defer until Make facet is shipped and we have a clearer UX for the join
direction (was the Make-vehicle the at-fault one? the one carrying the
victim? both?).

## Pipeline shape

```
njdot/data/vehicles.parquet  ─┐
njdot/data/crashes.parquet   ─┼─► njdot agg ─► yms/yccs/ymccs/ymccmcs (+ vd* cols)
                              │              └► ymak.parquet (top-K + OTHER)
[future] aashto/to_njdot_vehicles ─► aashto_supplemented_vehicles.parquet
```

## Implementation phases

1. **Phase 1 (this PR + follow-up)** — UI pivot: drop crash-level Severity
   from the Stack By menu for People/Vehicles. *(already landed in
   `CrashPlot.tsx`; no agg change.)*
2. **Phase 2** — Damage facet:
   - Extend `agg.py` to compute `vdn/vdm/vdo/vdx/vdu` for legacy years (join
     `vehicles.parquet` via `crash_id` ↔ crashes index, same pattern as the
     legacy VTC enrichment).
   - 2024+ columns are 0 (option B above).
   - UI: Damage filter (5-checkbox multi-select, like Condition) +
     Damage stack option, only enabled for `measure=Vehicles`.
   - NJTR-1 tooltips: pull from `extent_of_damage` mapping in `codes.py`.
3. **Phase 3** — Make facet:
   - New stage `njdot/agg_makes.py` → `www/public/data/njdot/ymak.parquet`.
   - Normalize free-text: title-case, common-typo map, top-30 + OTHER.
   - UI: Make-only stack option (high-cardinality stacks don't render well
     as filters; show a top-N legend).
4. **Phase 4** — AASHTO vehicles supplement (option A) — unlock 2024+ for
   all facets.
5. **Phase 5** — Make → fatalities page (separate from CrashPlot).

## Open questions

- **`damage` vs `departure`** — which makes a better default facet? Damage
  is the natural severity axis (None → Disabling) and parallels person
  Condition, but pre-2019 coverage is poor (~24%). Departure is well-coded
  but is post-crash disposition (drove away vs towed) rather than damage
  severity per se. I lean Damage for the first pass; revisit if it looks
  bad.
- **Make normalization rules** — strict whitelist (only the 30 top makes
  count; everything else → OTHER) or fuzzy match (handle "TOYTA" / "TOYOTO"
  typos)? Strict is simpler and probably sufficient.
- **Make facet UI for high-cardinality**: stack option only (no filter), or
  also a filter that lets users pick 5-10 makes to compare? Filter could
  use a search-style dropdown rather than a long checklist.
