# `raw/` — primary-source archive

A frozen mirror of the original bulk-data files behind NJ Crash Dashboard
([crashes.hudcostreets.org](https://crashes.hudcostreets.org)). Useful for
researchers, journalists, and anyone wanting to reconstruct the analyses
themselves.

## What's here

- [`njdot/data/`](njdot/data/) — NJ DOT bulk crash dumps, 2001–2023.
  Five tables per year (Accidents, Drivers, Occupants, Pedestrians,
  Vehicles) that join on a crash case key. Per-year statewide files
  through 2022; per-county files for 2023+.
- [`njdot/data/fields/`](njdot/data/fields/) — column schemas (JSON +
  original NJDOT PDF data dictionaries) for the fixed-width `.txt` files
  inside each `.zip`.

## What's *not* here

- 2024+ NJDOT data is not in this format. NJ DOT's current AASHTO BTDS
  dashboard exports a single denormalized "Crash.csv" instead of the
  five-table layout — losing the structure that joined people-events to
  vehicles to crashes. Restoring that structure for 2024+ is the
  motivating ask behind this archive.

## Format conventions

Files end in:
- `.zip` — original archive as published by NJ DOT. Contains a single
  fixed-width `.txt` with the same stem.
- `.pqt` — Parquet copy parsed via the `fields/` schemas. Same data,
  range-paginated, much faster to navigate.
- `.txt` — the parsed text file (only some years).

Click any `.zip` to inspect its entry list; click an entry to preview
it. Click a `.pqt` for a paginated table view. Click a directory to
list its contents.
