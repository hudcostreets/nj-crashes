# NJ Crashes Project Context

This document contains important context for Claude Code when working on this project.

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
- `njsp/cli/update_www_data.py`: Generate frontend CSV data files from NJSP crash records

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
- `monthly.csv`: Per-month fatality counts with type breakdown. Has statewide (`county=''`), county (`mc IS NULL`), and municipality rows. Pre-2020 type breakdown only exists at statewide level.
- `year-type-county.csv`: Per-year, per-county fatality counts by type. County-level only (no municipality).
- `ytd.csv`: Year-to-date cumulative fatality data per day-of-year.
- `crash-homicide.csv`: Traffic deaths vs homicides comparison. Has NJSP (2001–) and NJDOT (2001–) sources, statewide and county levels.

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
GHA workflow at `.github/workflows/daily.yml` runs at 11:10 AM EDT daily. Stages (in order): `refresh.dvc` → `update_pqts.dvc` → `harmonize.dvc` → `crash-log.parquet.dvc` → `summaries.dvc` → `projections.dvc` → `csvs.dvc` → `slack_post.dvc` → `deploy.dvc`. Each stage uses `dvx run --commit --push each` so commits and pushes incrementally. The matcher (`njsp_njdot_match.parquet.dvc`) is *not* in the daily chain — NJDOT only updates annually, so matches are run manually when that happens.

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

### Denormalized PK Inconsistency (RESOLVED)

**Problem**: Crashes undergo geocoding that updates cc/mc values, but V/D/O/P retain original cc/mc from raw data.

**Manifestation**:
- Raw crash: `(2023, cc=03, mc=17, case='2023-00002089')`
- After geocoding in `rawdata/pqt.py`: `(2023, cc=03, mc=38, case='2023-00002089')`
- Raw vehicle: `(2023, cc=03, mc=17, case='2023-00002089', vn=1)` ← still has old cc/mc
- Join fails! Vehicle becomes orphan.

**Scale**: ~80,923 vehicles affected in 2023 alone (likely similar for D/O/P across all years with geocoding).

**Solution Implemented** (PK Mapping Table):

1. **`rawdata/pqt.py`**: Preserve original cc/mc as `cc0`/`mc0` before geocoding
   - Added lines 107-108: Save original values immediately after loading
   - Georeferencing happens after this (Port Authority, empty municipality fixes)

2. **`crashes.py`**: Export PK mapping table
   - Added `cc0`/`mc0` to renames (lines 44-45) and astype (lines 78-79)
   - Modified `load()` to export `njdot/data/crash_pk_mappings.parquet` (lines 234-247)
   - Mapping: `(year, cc0, mc0, case) → (cc, mc)` for all crashes

3. **V/D/O/P `map_df()`**: Apply mapping before joining to crashes
   - Load mapping table if it exists
   - Merge on `(year, cc, mc, case)` = `(year, cc0, mc0, case)` from mapping
   - Update denormalized cc/mc fields to match geocoded crash PKs
   - Example: `vehicles.py:185-231`, `pedestrians.py:98-148`, `occupants.py:138-171`

**Why This Works**:
- Preserves full provenance: original cc/mc stored as `cc0`/`mc0` in crashes
- Mapping table tracks ALL PK transformations (not just geocoded ones)
- V/D/O/P can update their denormalized PKs using unique key `(year, cc0, mc0, case)`
- Maintains referential integrity: all V/D/O/P records can join to crashes

**Related Files**:
- `njdot/rawdata/pqt.py:107-108,117-146,148-180` - Preserve cc0/mc0, Port Authority + geocoding
- `njdot/crashes.py:44-45,78-79,234-247` - Export PK mapping table
- `njdot/vehicles.py:185-231` - Apply mapping before joining
- `njdot/pedestrians.py:98-148` - Apply mapping before joining
- `njdot/occupants.py:138-171` - Apply mapping before joining
