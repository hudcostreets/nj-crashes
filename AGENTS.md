# NJ Crashes Project Context

This document contains important context for Codex when working on this project.

## Project Overview

This repository analyzes NJ car crash data from two sources:
- **NJSP**: Fatal crashes (2001-present), small datasets, git-tracked, daily updates. XML feed covers 2008+; pre-2008 rows backfilled from annual-report PDFs (`type_source='pdf-only'`).
- **NJDOT**: All crashes (2001-2023), large datasets, DVC-tracked in S3, annual updates.
- **Harmonized crash-pair matches** between the two: `njsp/data/njsp_njdot_match.parquet` (NJSP↔NJDOT fatal-crash PKs, produced by `njsp match_njdot`, currently ~93% coverage).

## Municipality Code Complexity

There are THREE different municipality coding systems:
- **NJDOT**: Uses codes 1-N per county (N varies by county)
- **NJSP**: Different codes than NJDOT for same municipalities
- **NJGIN**: Canonical codes from NJ GIS data (superset of both)

`njdot/harmonize_muni_codes.py` creates mappings between all three systems.

## Primary Key Structure

**Crashes PK**: `(year, cc, mc, case)` where:
- `year`: 4-digit year (2001-2023)
- `cc`: County code (01-21, plus 99 for Port Authority)
- `mc`: Municipality code (varies by county, 1-N)
- `case`: Department case number (string, NOT unique across cc/mc!)

**Important**: `(year, case)` is NOT unique - 751,473 duplicates exist across counties/municipalities (11.4% of all crashes). Always use the full 4-field PK.

Other types reference crashes via denormalized PK fields:
- **Vehicles PK**: `(year, cc, mc, case, vn)`
- **Drivers PK**: `(year, cc, mc, case, vn)` (shares vn with vehicle)
- **Occupants PK**: `(year, cc, mc, case, vn, on)`
- **Pedestrians PK**: `(year, cc, mc, case, pn)`

## Key Files

### Data pipeline
- `njdot/rawdata/pqt.py`: Parse raw .txt files to .pqt, apply structural fixes (geocoding, Port Authority drops)
- `njdot/harmonize_muni_codes.py`: Reconcile municipality codes/names across NJDOT/NJSP/NJGIN via majority voting
- `njdot/crashes.py`: Main crashes data transformation pipeline
- `njdot/README.md`: Comprehensive pipeline documentation, including 2023 data quality issues
- `njsp/cli/update_www_data.py`: Generate frontend Parquet data files from NJSP crash records

### Frontend (`www/`)
- `www/src/njsp/FatalitiesPerYearPlot.tsx`: "Car Crash Deaths" — stacked bar by type (By Year) or monthly bars + 12-mo avg (By Month). Supports statewide, county, and municipality levels.
- `www/src/njsp/FatalitiesByMonthBarsPlot.tsx`: "Fatalities by Month" — bars per year grouped by month, with victim-type multi-select dropdown.
- `www/src/njsp/YtdDeathsPlot.tsx`: "YTD Deaths" — year-to-date cumulative lines. Three view modes: YTD, Faded (configurable future opacity/dash), Full. Settings gear has Future opacity, dash style, and Dim (greyed trace) sliders.
- `www/src/njsp/HomicidesComparisonPlot.tsx`: "Traffic Deaths vs. Homicides" — dual-source (NJSP/NJDOT) grouped bars + ratio line on secondary y-axis.
- `www/src/njdot/CrashPlot.tsx`: "NJ DOT Crash Data" — parquet-powered stacked bars with severity/county/municipality stacking, severity filters, time granularity toggle.
- `www/src/routes/Home.tsx`: Main page, passes geo filter (`cc`/`mc`/`countyName`) to all plots.
- `www/src/icons.tsx`: SVG casualty icons (Driver, Passenger, Pedestrian, Cyclist) used in crash table and plot legends.
- `www/src/raw/`: `/raw/*` file browser over the R2 mirror of NJDOT/NJSP bulk archives (zip / txt / parquet / pdf / dir listings with READMEs and `?q=` glob filter). Backed by `cells-api`'s `/v1/raw/*` endpoints. Demo surface for the DOT-BTDS conversation about restoring the per-table layout for 2024+.
- `www/src/routes/SqlPage.tsx`: `/sql` — DuckDB-WASM REPL. `?path=raw/...` deeplinks pre-fill `SELECT * FROM read_parquet('<worker-url>')`; reachable via "open in SQL ↗" from each `<ParquetTable>`.

### Frontend data files (`www/public/njsp/`)
All Parquet (converted from CSV 2026-05-21, ~2.4MB → 283KB total) and consumed via DuckDB-WASM, except `projected.csv` which stays CSV (tiny, ~500B).
- `monthly.parquet`: Per-month fatality counts with type breakdown. Has statewide (`county=''`), county (`mc IS NULL`), and municipality rows. Pre-2020 type breakdown only exists at statewide level.
- `month-year.parquet`: Per-month-of-year fatality counts (drives `FatalitiesByMonthBarsPlot`).
- `year-type-county.parquet`: Per-year, per-county fatality counts by type. County-level only (no municipality).
- `ytd.parquet`: Year-to-date cumulative fatality data per day-of-year.
- `crash-homicide.parquet`: Traffic deaths vs homicides comparison. Has NJSP (2001–) and NJDOT (2001–) sources, statewide and county levels.
- `projected.csv`: Rest-of-year fatality projections by `(cc, mc)` — county rows (blank cc/mc) + muni rows; written by `njsp/cli/update_projections.py`.

## DVX (Data Version Control)

This project uses [DVX](https://github.com/runsascoded/dvx), a lightweight DVC wrapper that embeds computation metadata directly in `.dvc` files. Each `.dvc` file is self-contained with:
- `outs`: The tracked file with its MD5 hash
- `meta.computation.cmd`: Command to regenerate the file
- `meta.computation.deps`: Dependencies with their MD5 hashes

Example from `njdot/data/crashes.parquet.dvc`:
```yaml
outs:
  - md5: cfb770bf...
    path: crashes.parquet
meta:
  computation:
    cmd: njdot compute pqt -t crashes
    deps:
      njdot/data/2001/NewJersey2001Accidents.pqt: 9e5d8dc8...
      njdot/data/2002/NewJersey2002Accidents.pqt: e8e4efc4...
      # ... all yearly files
```

### DVX Commands
```bash
# Check freshness (are outputs up-to-date with deps?)
dvx status

# Run all stale computations
dvx run

# Run specific target
dvx run njdot/data/crashes.parquet.dvc

# Add a file with computation metadata
dvx add output.parquet --dep input.parquet --cmd "python process.py"

# Push/pull data from S3
dvx push
dvx pull
```

### Key DVX-tracked Files
- `njdot/data/crashes.parquet.dvc` - Combined crashes (depends on yearly Accidents.pqt)
- `njdot/data/vehicles.parquet.dvc` - Combined vehicles
- `njdot/data/drivers.parquet.dvc` - Combined drivers
- `njdot/data/occupants.parquet.dvc` - Combined occupants
- `njdot/data/pedestrians.parquet.dvc` - Combined pedestrians
- `njsp/data/njsp_njdot_match.parquet.dvc` - NJSP↔NJDOT fatal-crash matches (see `specs/njsp-njdot-fatal-harmonization.md`)

### Daily pipeline
GHA workflow at `.github/workflows/daily.yml` runs at 11:10 AM EDT daily. Stages (in order): `refresh.dvc` → `update_pqts.dvc` → `harmonize.dvc` → `crash-log.parquet.dvc` → `summaries.dvc` → `projections.dvc` → `njsp_njdot_match.parquet.dvc` → `aashto_supplemented_crashes.parquet.dvc` → `ymccmc.dvc` + `ymccmcs.dvc` → `csvs.dvc` → `slack_post.dvc` → `api/d1-import.dvc` → `deploy.dvc`. Each stage uses `dvx run --commit --push each` so commits and pushes incrementally. The matcher + supplement + agg trio runs daily so NJSP-only-2025 fatals (the AASHTO fatal-reclassification lag concentrated in Middlesex/Hudson/Essex) flow into the homepage NJDOT plot as NJSP receives them. `api/d1-import.dvc` runs `bash api/scripts/d1-import.sh --inplace njsp-crashes` to drop+create+insert the `NJSP_CRASHES_DB` D1 binding inplace (no staging-swap, brief inconsistency window). Full re-import of all DBs (njdot/* + njsp) uses the staging-swap workflow: `bash api/scripts/d1-import.sh` (no flags), run manually after annual NJDOT updates.

## Useful Commands

```bash
# Download/process new year data
rawdata zip -r NJ -y 2023
rawdata txt -r NJ -y 2023
rawdata pqt -r NJ -y 2023

# Check for schema changes
rawdata fsck fields -r NJ -y 2023

# Harmonize municipality codes
njsp harmonize_muni_codes

# Generate combined parquets + databases
env -u PYTHONPATH njdot compute pqt -f
env -u PYTHONPATH njdot compute db -f
```

Note: Use `env -u PYTHONPATH` to avoid shadowing PyGithub package.

## Historical Context

- **2021**: Used as canonical year for municipality names (not 2023) because some codes were dropped/merged in 2022-2023 (e.g., Princeton Borough/Township merger)
- **Pre-2023**: No data quality conflicts - all assertions passed
- **2023**: First year with data quality regressions requiring majority voting

## Known Issues

### Denormalized PK: join children on the crash's RAW `mc_dot`

**Problem**: geocoding in `rawdata/pqt.py` (Port Authority + empty-muni fixes) moves a crash's `(cc, mc)` away from the raw code, but V/D/O/P records keep the *original* raw `(cc, mc)`. A child→crash join on the *geocoded* `mc` orphans every geocoded crash's children.

**Resolution**: the crash keeps its pre-geocode raw code as **`mc_dot`**, and `load.py:normalize` joins the child's raw `(year, cc, mc, case)` against the crash's `(year, cc, mc_dot, case)` — raw↔raw, globally unique (`mc_dot` also disambiguates Princeton Boro/Twp — see "Non-unique 4-field crash PK" above). The child output keeps only `crash_id` (it stores no cc/mc), so **no per-child cc/mc remap is needed or wanted**. `compute_victim_counts` handles the same geocoding independently by merging victims on the crash's preserved `(cc0, mc0)` — guarded by `tests/test_victim_counts.py`.

**Regression (fixed 2026-09-11, `410fb93f39e`)**: the 2026 data-pipeline PR `bd7e38cfaeb` added a `crash_pk_mappings` merge to the child `map_df`s that overwrote the child `mc` with the *geocoded* value **before** the raw `mc_dot` join — silently orphaning ~18% of children (99.8% of geocoded crashes: −2.2M occupants / −1.7M vehicles / −25k pedestrians, uniform across all years, shipping since 2026-04). Removed; the raw `mc_dot` join alone is correct. Guarded by `tests/test_child_crash_join.py`. (`crash_pk_mappings.parquet` is still emitted by `crashes.py` — now unused by the child builders, a candidate for later removal; `cc0`/`mc0` remain the crash's preserved raw code, used by `compute_victim_counts`.)
