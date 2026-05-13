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
| `damage`    | Int8 (1-4) | "Extent of Damage"         | **0% pre-2017, 93%+ 2017-2022** (NOT a partial-coverage gradient — NJDOT only started capturing this field in 2017) |
| `departure` | Int8 (1-6) | "Driven/Left/Towed"        | 87-95% across all years 2001-2022 |
| `make`      | string     | Free text                  | ~95% (215K uniques)  |
| `model`     | string     | Free text                  | ~95%, even noisier   |
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

1. **Phase 1 (landed)** — UI pivot: drop crash-level Severity from the Stack
   By menu for People/Vehicles. `CrashPlot.tsx`, no agg change.
2. **Phase 2 (landed)** — Damage *and* Departure facets:
   - `agg.py` joins `vehicles.parquet` via `crash_id` ↔ crashes index (same
     pattern as the legacy VTC enrichment), produces:
     - 5 damage cols: `vdx/vdo/vdm/vdn/vdu` (Disabling/Moderate/Minor/None/
       Unknown). Pre-2017 + AASHTO 2023+ all land in `vdu`.
     - 4 departure buckets: `vepd/vepl/vept/vepu` (Driven/Left/Towed-any/
       Unknown). 87-95% coverage 2001-2022; AASHTO 2023+ in `vepu`.
     - The 6 fine-grained Departure codes (Towed-Disabled / -Impounded /
       -Both / -legacy) collapse to one `vept` bucket — fine-grained
       distinctions don't survive the pre-2017 "Towed-legacy" gap anyway.
   - UI: Damage + Departure both available as Stack By options (only
     enabled when `measure=Vehicles`); each has its own filter checklist.
     Defaulting Vehicles to `damage` stack on first switch.
   - NJTR-1 tooltips wire to `extent_of_damage` + `vehicle_departure` in
     `codes.py`.
3. **Phase 3** — Make facet:
   - New stage `njdot/agg_makes.py` → `www/public/data/njdot/ymak.parquet`.
   - Normalize free-text: title-case, common-typo map, top-30 + OTHER.
     Strip model leakage when first token is a known make ("HONDA ACCORD" →
     "HONDA"). After this: top-30 covers **86%** of vehicles (vs 73% raw).
     Add a fuzzy-match pass (edit-distance ≤ 1 to a top-30 make) for
     "TOYTA"-class typos, expected to lift coverage another 2-4 pp.
   - UI: filter+stack (like Damage / Departure / Condition / VictimType) —
     filter checklist of top-30 + OTHER, plus a searchable subset UI when
     more than 10 makes are checked.
4. **Phase 4 (landed)** — AASHTO vehicles supplement:
   - `njdot aashto vehicles` produces `aashto_supplemented_vehicles.parquet`
     (1.5M rows across 2023-2025).
   - Damage coverage 94-98% (AASHTO "Extent of Damage" → legacy codes 1-4).
   - Departure coverage low (~18%) because AASHTO's "Removed To" is mostly
     free-text placeholder ("None" most common).
   - `agg.py` joins on `(year, cc, mc, case)` for AASHTO years; legacy
     `vehicles.parquet` still drives 2017-2022.
5. **Phase 5** — Make → fatalities page (separate from CrashPlot).

## Decisions

- **Damage vs Departure**: ship both, default Vehicles → Damage stack. The
  2001-2016 Damage gap is too large to use Damage alone (16 of 25 years all
  in Unknown), so Departure stays available as the cross-era alternative.
- **Make normalization**: top-30 whitelist + OTHER bucket, with both a
  prefix-strip pass ("HONDA ACCORD" → "HONDA") and a fuzzy/edit-distance
  pass for typos. Cumulative top-30 coverage: 73% raw → 86% after prefix-
  strip → ~88-90% after fuzzy.
- **Make UI**: filter+stack, same shape as Damage / Departure / Condition /
  Victim Type. Top-30 + OTHER as a single 31-row checklist; if the list
  feels long in practice, add a search input above.
