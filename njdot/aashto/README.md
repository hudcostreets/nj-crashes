# `njdot/aashto/` — AASHTO `Crash.csv` → per-table normalizer

NJ DOT's new dashboard
([njdot.aashtowaresafety.net](https://njdot.aashtowaresafety.net/njdot-crash-data-dashboard),
vendor: [Numetric](https://www.numetric.com/)) replaced the per-table
bulk dumps (2001–2023) with a single `Crash.csv` per year. The CSV
encodes per-vehicle and per-person facts as JSON-arrays inside CSV
cells, with a 2-D nesting that approximates `[[...persons in vehicle
0...], [...persons in vehicle 1...], ...]` for per-person columns and
flat `[veh_0_attr, veh_1_attr, ...]` for per-vehicle columns.

This script normalizes that into the same per-table shape the
`rawdata` site used to ship (Accidents / Drivers / Occupants /
Pedestrians / Vehicles), so analyses built on the pre-2024 layout
can extend to 2024+.

## Outputs

`normalize.py -y <year> <Crash.csv>` writes four parquets under
`<out-dir>/<year>/` (default `njdot/data/<year>/`):

- **`crashes.parquet`** — one row per crash. 85 trailing crash-level
  cols + 9 leak cols + 5 compound multi-valued cols (kept as JSON
  strings).
- **`vehicles.parquet`** — one row per `(crash_id, vehicle_index)`. 31
  per-vehicle cols (Vehicle Make/Type, Driver Age + License, Initial
  Impact, Direction of Travel, Hit and Run, Alcohol Test, Pre-Crash
  Action, etc.).
- **`persons.parquet`** — one row per `(crash_id, person_index)`. 14
  per-person cols (Age, Sex, Person Type, Position in Vehicle, Injury
  Status, Severity Rating, Ejection, Safety Equipment Used/Available,
  Zip Code, etc.) plus `vehicle_index` FK to `vehicles`.
- **`issues.parquet`** — long-form data quality findings keyed to
  input CSV rows. Cols: `row_idx`, `crash_id`, `column`,
  `issue_type`, `detail`, `raw_value`. Use for AASHTO/Numetric
  feedback.

## Recovery rates (full-year runs)

| Year | Input rows | Crashes recovered | Vehicles | Persons | Dropped (fatal) | Person→Vehicle orphans |
|---|---:|---:|---:|---:|---:|---:|
| 2024 | 265,823 | 265,823 | 519,806 | 635,530 | 5,803 (2.14%) | 0 |
| 2025 | 261,173 | 261,173 | 508,357 | 628,429 | 3,195 (1.21%) | 0 |

## Issue policy

- **Fatal** (crash dropped, recorded in `issues.parquet` as `FATAL`):
  - missing or non-unique `Crash ID`
  - person- or vehicle-count exceeds sanity bounds (1000 / 200)
  - per-person column whose flat length doesn't match `Person ID`'s
    flat length — this would scramble the person→attribute join
- **Warn** (coerced + logged in `issues.parquet`):
  - literal string `[object Undefined]` (a JS coercion artifact in the
    upstream renderer) → coerced to `null`
  - per-vehicle col with unexpected nesting → take the `vi`-th
    sub-tuple (or first element if length 1, broadcast)
  - per-vehicle col where flat length matches `person_dim` instead of
    `vehicle_dim` → null for that vehicle, flagged

The fatal/warn split is conservative on relational integrity (anything
that would break a join is fatal) and lenient on cell-level oddities
(coerce + log).

## Open questions / followups

- **Doubly-nested per-vehicle cols** like `Vehicle Model =
  [[null,null],["EXPO","ODYSSEY"]]` — flat length is `2 × vehicle_dim`,
  suggesting each vehicle has a 2-tuple. Currently joined with `;` and
  flagged. Spot-inspect a populated row to figure out the semantics.
- **Ambiguous columns** (60–90% per-person, 25–35% per-vehicle by
  alignment): currently dropped (`AMBIGUOUS_DROPPED_COLS` in
  `normalize.py`). Likely per-person (Eye Color, Hospital, Injury
  Type, Refused Treatment, etc.). Want guidance from AASHTO before
  picking a tier.
- **Duplicate `State` column name** in the header (cols 66 and 67) —
  dict-keyed cell access conflates them. Switch to index-keyed access
  to recover both.
- **`[object Undefined]` literals** are widespread enough that fixing
  them upstream would meaningfully improve the data; worth flagging
  to AASHTO with row counts from `issues.parquet`.
