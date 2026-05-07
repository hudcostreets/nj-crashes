# `njdot/data/` — NJ DOT bulk crash dumps

Per-year subdirectories (`2001/` through `2023/`) hold the original NJ
DOT crash data. Five table types per year (each as a `.zip` containing a
single fixed-width `.txt`, plus a parquet `.pqt` copy for some years):

| Table | Description | PK |
|---|---|---|
| **Accidents** | One row per crash | `(year, cc, mc, case)` |
| **Drivers** | One row per driver per crash | `(year, cc, mc, case, vn)` |
| **Occupants** | One row per occupant (incl. driver) | `(year, cc, mc, case, vn, on)` |
| **Pedestrians** | One row per pedestrian-involved person | `(year, cc, mc, case, pn)` |
| **Vehicles** | One row per vehicle | `(year, cc, mc, case, vn)` |

(Where `cc` = county code, `mc` = municipality code, `case` = department
case number, `vn` = vehicle number, `on` = occupant number, `pn` =
pedestrian number.)

## Layout transition

- **2001–2022**: Statewide files only — `NewJersey<year><Table>.{zip,pqt}`.
  One ~10 MB zip per table per year.
- **2023+**: Per-county files only — `<County><year><Table>.zip`. 21
  counties × 5 tables = 105 zips per year. (Easier for NJ DOT to publish
  incrementally; harder to consume programmatically.)

## Column schemas

See [`fields/`](fields/) for the column layout of every fixed-width
`.txt`. NJ DOT updated the schema in 2017, so there are two versions
(`2001*Table.json` and `2017*Table.json`); apply the `2017*` schema for
files dated 2017 or later.
