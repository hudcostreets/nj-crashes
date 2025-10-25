# NJ Crashes Project Context

This document contains important context for Claude Code when working on this project.

## Project Overview

This repository analyzes NJ traffic crash data from two sources:
- **NJSP**: Fatal crashes (2008-present), small datasets, git-tracked, daily updates
- **NJDOT**: All crashes (2001-2023), large datasets, DVC-tracked in S3, annual updates

## Municipality Code Complexity

There are THREE different municipality coding systems:
- **NJDOT**: Uses codes 1-N per county (N varies by county)
- **NJSP**: Different codes than NJDOT for same municipalities
- **NJGIN**: Canonical codes from NJ GIS data (superset of both)

The `harmonize-muni-codes.ipynb` notebook creates mappings between all three systems.

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

- `njdot/rawdata/pqt.py`: Parse raw .txt files to .pqt, apply structural fixes (geocoding, Port Authority drops)
- `njdot/harmonize-muni-codes.ipynb`: Reconcile municipality codes/names across NJDOT/NJSP/NJGIN via majority voting
- `njdot/crashes.py`: Main crashes data transformation pipeline
- `njdot/README.md`: Comprehensive pipeline documentation, including 2023 data quality issues

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

### Denormalized PK Inconsistency (UNRESOLVED)

**Problem**: Crashes undergo geocoding that updates cc/mc values, but V/D/O/P retain original cc/mc from raw data.

**Manifestation**:
- Raw crash: `(2023, cc=03, mc=17, case='2023-00002089')`
- After geocoding in `rawdata/pqt.py`: `(2023, cc=03, mc=38, case='2023-00002089')`
- Raw vehicle: `(2023, cc=03, mc=17, case='2023-00002089', vn=1)` ← still has old cc/mc
- Join fails! Vehicle becomes orphan.

**Scale**: ~80,923 vehicles affected in 2023 alone (likely similar for D/O/P across all years with geocoding).

**Attempted Fix** (incomplete):
- Tried updating V/D/O/P cc/mc by merging on `(year, case)` only
- FAILED: `(year, case)` is not unique (751k duplicates across 6.5M crashes)

**Proper Solution** (TODO):
1. In `crashes.py`, before deduplication/geocoding, create PK mapping table:
   ```
   (year, cc_old, mc_old, case) → (year, cc_new, mc_new, case)
   ```
2. In `rawdata/pqt.py` or `crashes.py`, persist this mapping to `njdot/data/crash_pk_mappings.parquet`
3. In V/D/O/P `map_df()`, load mapping and update denormalized cc/mc fields BEFORE joining to crashes
4. This preserves referential integrity while allowing crash geocoding

**Related Files**:
- `njdot/rawdata/pqt.py:117-146` - Port Authority geocoding (00,00) → (99,01/02)
- `njdot/rawdata/pqt.py:148-180` - Empty municipality name geocoding via lat/lon
- `njdot/vehicles.py:185-224` - Current (broken) orphan handling
- `njdot/pedestrians.py:98-140` - Current (broken) orphan handling
- `njdot/occupants.py:138-208` - Current (broken) orphan handling
