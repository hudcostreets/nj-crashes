# Data Sources page

New route `/data` (or `/sources`) explaining where the site's NJ crash data comes from, documenting the transition from NJDOT's old raw-zip pipeline to the new AASHTO dashboard, providing direct access to archived raw files, and visualizing known data-quality gaps in the dashboard.

## Status update (2026-05-10)

Significant work has happened since this spec was written:

- **AASHTO normalizer**: `njdot/aashto/normalize.py` now extracts per-table layout (crashes / vehicles / persons / issues) from the denormalized `Crash.csv`. Recovery rates: 2024=97.86%, 2025=98.79%. The "denormalized to primary unit only" claim below is no longer accurate — we recover ~14 per-person + 31 per-vehicle columns cleanly.
- **Schema mapper**: `njdot/aashto/to_njdot_schema.py` maps AASHTO → NJDOT schema; site reads through 2025.
- **Strict-vs-broad fatal definition**: surfaced + fixed (see `project_njdot_fatality_definitions.md`). The 2023 "~74% complete" framing below is wrong — 2023 AASHTO is actually slightly *more* accurate than the per-table archive (which has the broad/strict mismatch).
- **`/harmonization` page**: covers some of the "where does this data come from" story (3-way SP↔DOTr↔DOTa). New here: per-county fatal-classification lag visualization.
- **`/raw` browser**: covers the "archived zip manifest + direct links" need. Already deployed.

What's still missing that this spec would add:
- The dashboard-completeness visualization (Section 3) — but with the stricter definition + matcher work, the muni-level gaps story is more nuanced than "Clifton 8% complete".
- Section 5's pipeline-tour content. Could fold into the `/raw` browser README or `/harmonization`'s explainer.

Recommendation: rescope this spec to either fold into `/h11n` or drop in favor of a thinner "About / Data" page link. Defer pending forum demo + push.

## Motivation

As of 2026-04-21:

- NJDOT's public index at https://dot.nj.gov/transportation/refdata/accident/rawdata01-current.shtm caps its dropdown at 2018 (cosmetic — 2019-2023 zips are still hosted at the old URL pattern, just unlisted).
- 2024/2025 raw zips are not published at the old URL pattern (404).
- The new AASHTO dashboard at https://njdot.aashtowaresafety.net/njdot-crash-data-dashboard/ has 2018-2025 data but:
  - 2022 is complete (~100% match with raw zip aggregate)
  - 2023 is ~74% complete, with **bimodal per-municipality coverage**: some PDs at 99-100%, others at <20% (Clifton 8%, Medford 6%, Plainfield 10%, Atlantic City 10%, Mount Laurel 12%, etc.)
  - 2024 is ~65-70% complete across all months
  - 2025 matches expected full-year volume
- The dashboard's CSV export is denormalized (1 row per crash with primary-unit driver/vehicle/occupant fields), lossy for multi-vehicle crashes.

We have local copies of all raw zips from 2001-2023 (tracked via DVX). Hosting them ourselves fills the gap left by NJDOT's cosmetic listing change.

## Page content

### Header

Title: "NJ Crash Data Sources" (or "Where this data comes from")

Intro paragraph explaining:
- Site aggregates two primary sources: NJSP daily fatal-crash feed (2001-present) and NJDOT annual raw-zip files (2001-2023).
- NJDOT publishes raw crash data in bulk every 1-2 years; dashboards have emerged as the new distribution channel.

### Section 1: Old NJDOT raw-zip pipeline

- Describe the old URL pattern: `https://dot.nj.gov/transportation/refdata/accident/{year}/{County}{year}{tbl}.zip` for 21 counties × 5 tables (Accidents, Drivers, Occupants, Pedestrians, Vehicles) × 2001-2023.
- Note that 2019-2023 zips are still hosted but delisted from the dropdown page.
- **Link to our archived copies** (DVX-tracked, served from S3/CF): table with rows for each year, columns for each table type.
  - Options: generate a static manifest from `njdot/data/**/*.zip` + direct links to the public S3/CF URLs.
- Explain our processing pipeline (txt → parquet, geocoding, PK harmonization).

### Section 2: AASHTO dashboard transition

- Link to the new dashboard: https://njdot.aashtowaresafety.net/njdot-crash-data-dashboard/
- Explain what it offers: interactive filters, data through 2025-YTD, denormalized CSV export.
- Summarize known limitations:
  - 500-row search cap, no pagination
  - Download endpoint historically flaky (FILE_IN_PROGRESS → 500 errors)
  - Ingestion gaps per-municipality in 2023-2024
  - CSV schema denormalized to primary unit only

### Section 3: Known 2023 gaps — interactive visualization

Per-municipality completeness comparison for 2023:
- Bar chart (or choropleth) showing dashboard% per muni, sorted by completeness
- Tooltip shows: existing-pipeline count, dashboard count, gap
- Filter by county
- Highlight the bimodal pattern: ~⅔ of munis at 95%+, ~⅓ at <40%

Per-month completeness:
- Line chart: x=month, y=dashboard/existing %, stratified by a few example munis (Clifton, Medford, Plainfield, Brick, Neptune)
- Shows that some munis (e.g., Medford) had their ingestion break mid-year

Data for these plots: pre-computed parquet published under `www/public/data/source-diffs.parquet` with columns `(year, cc, mc, muni, month, existing_count, dashboard_count)`.

### Section 4: Current status (2024/2025)

- 2024: dashboard-only source, ~70% complete at the dashboard's own threshold.
- 2025: dashboard-only, looks complete but unverified without raw zips.
- Note pending outreach to NJDOT (link to/copy of the support request).

### Section 5: Our fetch pipeline

- Brief description of `njdot/rawdata/zip.py` — ETag/Last-Modified revalidation, parquet cache at `njdot/data/.cache.pqt`, headers `[Date, Content-Length, Content-type, Last-modified, Etag]`.
- Future consolidation: `dvx import-url` supports the same revalidation natively with `--user-agent`, letting us drop the custom cache.

## Implementation

### Data artifacts

1. **Archived zip manifest**: script `njdot/cli/archive_manifest.py` that walks `njdot/data/**/*.zip.dvc`, emits `www/public/njdot/zip-manifest.json`:
   ```json
   [
     {"year": 2023, "county": "Atlantic", "table": "Accidents", "size": 417348, "md5": "...", "url": "https://..."},
     ...
   ]
   ```
2. **Source diff parquet**: script `njdot/cli/export_source_diffs.py` that reads both existing parquet and each dashboard `Crash.csv`, outputs `(year, cc, mc, month, existing_count, dashboard_count)` tuples.
   - Run offline as pre-computation; check result into git or DVX-track.

### Frontend

- New route `/data` → `www/src/routes/DataSources.tsx`
- Uses existing `PlotWrapper` + `pltly` for the interactive charts
- Reuse table styles from `MatchReview.module.scss` for the zip manifest table

### Out of scope for v1

- Fixing the dashboard ETL — separate effort (see `specs/dashboard-etl.md` if/when created)
- Programmatically regenerating the muni-level diff parquet in the daily pipeline (manual regenerate on each new NJDOT raw-zip publication is fine)

## Implementation order

1. `archive_manifest.py` + static manifest JSON published to `/njdot/zip-manifest.json`
2. `export_source_diffs.py` + `source-diffs.parquet`
3. `DataSources.tsx` route with manifest table + per-muni diff viz
4. Link from site header / footer / NavBar

## Post-4/25-forum priority

This is not urgent — spec-only until after the 2026-04-25 HCCS Transit Forum. Map pipeline work takes precedence.
