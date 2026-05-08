# `njdot/data/` — NJ DOT bulk crash dumps

Per-year subdirectories (`2001/` through `2025/`) hold original NJ DOT
crash data from two sources:

- [NJDOT "rawdata" site][rawdata] — per-table archive for `2001/`–`2023/`.
- [NJDOT crash dashboard][aashto] (vendor: AASHTO BTDS / [Numetric][numetric])
  — `Crash.csv` exports for `2024/`–`2025/`.

## Format eras

- **2001–2023 (per-table)**: Five tables — `Accidents` / `Drivers` /
  `Occupants` / `Pedestrians` / `Vehicles` — as fixed-width `.txt`s
  inside per-table `.zip`s. Statewide bundles
  (`NewJersey<year><Table>.{zip,pqt}`) every year; per-county bundles
  (`<County><year><Table>.zip`) appear sporadically through 2022 and
  become complete (21 × 5) in 2023.
- **2024+ (denormalized CSV)**: A single [`Crash.csv`](2024/Crash.csv)
  per year (~700 MB) exported from the new AASHTO dashboard.
  Per-person and per-vehicle facts are nested as JSON-arrays inside
  CSV cells, with `[[…persons in vehicle 0…], […persons in vehicle
  1…], …]` for per-person columns and `[v0_attr, v1_attr, …]` for
  per-vehicle columns. We recover the per-table layout via
  [`njdot/aashto/normalize.py`](../aashto/), which writes
  `crashes.parquet` / `vehicles.parquet` / `persons.parquet` /
  `issues.parquet` per year. ~98% of crashes round-trip cleanly with
  100% reliable Person→Vehicle joins.

## Per-table format

Five tables (2001–2023):

| Table | Description | PK |
|---|---|---|
| **Accidents** | One row per crash | `(year, cc, mc, case)` |
| **Drivers** | One row per driver per crash | `(year, cc, mc, case, vn)` |
| **Occupants** | One row per occupant (incl. driver) | `(year, cc, mc, case, vn, on)` |
| **Pedestrians** | One row per pedestrian-involved person | `(year, cc, mc, case, pn)` |
| **Vehicles** | One row per vehicle | `(year, cc, mc, case, vn)` |

(`cc` = county code, `mc` = municipality code, `case` = department
case number, `vn` = vehicle number, `on` = occupant number, `pn` =
pedestrian number.)

## Column schemas

See [`fields/`](fields/) for the column layout of every fixed-width
`.txt`. NJ DOT updated the schema in 2017, so there are two versions
(`2001*Table.json` and `2017*Table.json`); apply the `2017*` schema for
files dated 2017 or later.

## Notes on the upstream sites

### `rawdata01-current.shtm`: year dropdown stops at 2018

The page's year selector only offers values through 2018, but the
per-table zip URLs for 2019–2023 are still served — just
undiscoverable from the UI. Direct URL guessing (or scraping the
2018 page's link patterns) gets the rest.

### Issues with new dashboard

1. **Per-`Person` / per-`Vehicle` views don't seem accessible.** The
   nav has `People`, `Vehicles`, `Locations`, `Time`, etc. tabs, and
   the column picker exposes `(Crash)` / `(Person)` / `(Vehicle/Mode)`
   variants for many fields — suggesting the underlying data model
   still has those entities. But we haven't found a way to make the
   dashboard actually render a Person- or Vehicle-shaped table; the
   visible output stays Crash-shaped regardless of which `(Person)` /
   `(Vehicle/Mode)` columns we add. (`Apply` does work for Crash-level
   filters.)

2. **`Raw Data` view nests per-person/vehicle fields as arrays.**
   Cells in `Age`, `Airbag`, `Alcohol Test ID`, etc. show values like
   `[34, 31]`, `[35, [46, 3 more items]]`, `[[0, 0], [0, 63]]`, plus
   the literal string `[object Undefined]` (a JS coercion artifact).
   The bulk-export `Crash.csv` carries the same shape.

3. **`/api/dashboards/filterSearch` returns 500s.** Filter-menu
   interactions sometimes get back HTML "Internal server error" pages
   from the Numetric backend, each with a distinct request ID. Doesn't
   block `Apply` but suggests intermittent backend trouble.

[rawdata]: https://dot.nj.gov/transportation/refdata/accident/rawdata01-current.shtm
[aashto]: https://njdot.aashtowaresafety.net/njdot-crash-data-dashboard
[numetric]: https://www.numetric.com/
