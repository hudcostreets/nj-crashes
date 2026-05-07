# `njdot/data/2022/` — statewide bulk dumps

Last year of the **statewide** bulk-dump format. Five tables, each in
both `.zip` (NJ DOT's original) and `.pqt` (our parsed parquet copy):

- `NewJersey2022Accidents.{zip,pqt}` — crash-level rows
- `NewJersey2022Drivers.{zip,pqt}` — driver-level rows
- `NewJersey2022Occupants.{zip,pqt}` — occupant-level rows (incl. drivers)
- `NewJersey2022Pedestrians.{zip,pqt}` — pedestrian-level rows
- `NewJersey2022Vehicles.{zip,pqt}` — vehicle-level rows

Apply the [`fields/2017*Table.json`](../fields/) schemas to read the
fixed-width `.txt` inside each `.zip`. The `.pqt` copy is already parsed
— browse it directly for a paginated table view.

For 2023+ the format switched to per-county files; see
[`../2023/`](../2023/) for the new layout.
