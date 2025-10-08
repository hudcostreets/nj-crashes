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
