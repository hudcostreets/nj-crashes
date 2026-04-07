# 2023 Duplicate Data Analysis

This document summarizes the duplicate record issues discovered in the 2023 NJDOT data and the framework developed to handle them.

## Summary Statistics

| Entity | Total Records | Full Dupes | PK-only Dupes | Total PK Dupes | Dupe Groups | Max Group Size |
|--------|--------------|------------|---------------|----------------|-------------|----------------|
| Crashes | 250,570 | 0 (0.00%) | 5,745 (2.29%) | 5,745 (2.29%) | 2,872 | 3 |
| Vehicles | 473,233 | 316 (0.07%) | 7,494 (1.58%) | 7,810 (1.65%) | 3,905 | 2 |
| Occupants | 612,727 | 527 (0.09%) | 8,475 (1.38%) | 9,002 (1.47%) | 4,133 | 17 |
| Pedestrians | 7,657 | 151 (1.97%) | 149 (1.95%) | 300 (3.92%) | 144 | 6 |
| Drivers | 473,243 | ~10 | ~7,810 | ~7,820 | 3,910 | 2 |

**Definitions:**
- **Full Dupes**: Records where ALL columns are identical (exact duplicates)
- **PK-only Dupes**: Records with same primary key but different data (true conflicts)
- **Dupe Groups**: Number of unique primary keys that have duplicates

## Key Findings

### 1. Duplicates are Highly Correlated

The duplicate patterns show massive correlation across entity types:

| Correlation | Rate | Expected | Enrichment |
|------------|------|----------|------------|
| Vehicle dupes in crash dupes | 99.66% | 1.16% | **86.0x** |
| Occupant dupes in crash dupes | 55.39% | 1.16% | **47.8x** |
| Occupant dupes in vehicle dupes | 57.18% | 0.83% | **68.7x** |

**Interpretation**: When a crash has duplicate records, its vehicles and occupants are much more likely to have duplicates too. This suggests systematic duplication at the record ingestion/processing level rather than random data quality issues.

### 2. Crashes: UCASE/TCASE Pattern

Crash duplicates follow a clear pattern (69.5% of cases):
- **UCASE records**: Original/ungeocoded versions with ALL CAPS text fields
- **TCASE records**: Updated/geocoded versions with proper Title case text

**Example:**
```
UCASE: Police Department="MOUNT HOLLY TWP PD", Crash Location="MAIN ST", lat/lon=unreliable
TCASE: Police Department="Mount Holly Twp PD", Crash Location="Main St", lat/lon=geocoded
```

**Solution**: Smart merge strategy using TCASE as base, filling missing fields (SRI, MP, Cross Street) from UCASE when available. Successfully merged 4,000 of 5,745 duplicates (69.5%).

### 3. Vehicles: Smart Merge Based on Crash Version

Vehicle duplicates are primarily PK conflicts (7,494 of 7,810). The vehicle number (`vn`) is a foreign key referenced by occupants and drivers, so **renumbering is not possible**.

**Key insight**: 99.66% of vehicle duplicates occur in crashes with crash duplicates (86x enrichment). Each crash version (UCASE/TCASE) has its own vehicles. Line number ordering allows tracing vehicles back to their source crash with 100% accuracy.

**Solution**:
- For vehicles in UCASE/TCASE crash pairs: Keep vehicle from TCASE (geocoded/updated) crash
- For other duplicates: Keep first (fallback)
- **Success rate: 75.0%** intelligent merges (2,927 of 3,905 groups)

This is a huge improvement over arbitrary "keep first" which had 50% chance of keeping the worse version.

### 4. Occupants: Smart Merge + Renumbering

Occupant duplicates include:
- 4,406 records from crash duplication (55.39% correlation with crash dupes, 47.8x enrichment)
- 55,189 records with empty/hex-corrupted occupant numbers
- 527 full duplicates

**Solution** (applied in order):
1. **Smart merge**: For occupants in UCASE/TCASE crash pairs, keep occupant from TCASE crash
   - Success rate: **52.4%** intelligent merges (2,166 of 4,133 groups)
   - Uses line number ordering to trace occupants to source crash (99.9% accuracy)
2. **Drop full duplicates**: Remove exact duplicate records
3. **Renumber**: Assign sequential numbers [1, N] within each vehicle to fix empty/corrupted numbers

**Critical**: Smart merge must happen BEFORE renumbering (merge relies on original line numbers).

### 5. Pedestrians: Similar to Occupants

Pedestrian duplicates follow same pattern as occupants but on smaller scale (300 total dupes).

**Solution**: Drop full duplicates, then renumber [1, N] per crash.

## Duplicate Output Framework

A standardized framework writes duplicate analysis to side-output directories for manual inspection:

```
njdot/data/2023/
├── crash_dupes/
│   ├── merged.pqt          # All duplicate crash records
│   ├── merges.pqt          # Successfully merged crashes (ucase/tcase)
│   ├── merges-all.pqt      # All merge attempts
│   └── unmerged/
│       ├── 0.pqt           # First record of each duplicate group
│       ├── 1.pqt           # Second record
│       ├── 2.pqt           # Third record (rare)
│       └── all.pqt         # All unmerged duplicates
├── vehicles_dupes/
│   ├── merged.pqt          # All 7,810 duplicate vehicle records
│   └── unmerged/
│       ├── 0.pqt           # 3,905 first records
│       └── 1.pqt           # 3,905 second records
├── occupants_dupes/
│   ├── merged.pqt          # All 9,002 duplicate occupant records
│   └── unmerged/
│       ├── 0.pqt           # 4,133 first records
│       ├── 1.pqt           # 4,133 second records
│       ├── 2.pqt           # 446 third records
│       └── ... (up to 16.pqt for 17-record groups)
├── pedestrians_dupes/
│   └── ... (similar structure)
└── drivers_dupes/
    └── ... (similar structure)
```

**Metadata fields added to duplicate records:**
- `lineno`: Original line number in source .txt file
- `group_idx`: Unique identifier for each duplicate group
- `idx`: Position within duplicate group (0, 1, 2, ...)

## Usage

### Analyzing Duplicates

```bash
# Run comprehensive duplicate analysis
./njdot/analyze_2023_dupes.py
```

### Generating Duplicate Outputs

```bash
# Write side-output files for all entity types
./njdot/write_dupe_outputs.py

# Or enable during normal pipeline processing
export NJDOT_WRITE_DUPE_OUTPUTS=1
env -u PYTHONPATH njdot compute pqt -f
```

### Inspecting Duplicates

```python
import pandas as pd

# Load all duplicate vehicles
dupes = pd.read_parquet('njdot/data/2023/vehicles_dupes/merged.pqt')

# Compare first vs second records
first = pd.read_parquet('njdot/data/2023/vehicles_dupes/unmerged/0.pqt')
second = pd.read_parquet('njdot/data/2023/vehicles_dupes/unmerged/1.pqt')

# Find crashes with both crash and vehicle duplicates
crash_dupes = pd.read_parquet('njdot/data/2023/crash_dupes/merged.pqt')
vehicle_dupes = dupes
crash_keys = set(crash_dupes[['County Code', 'Municipality Code', 'Department Case Number']].itertuples(index=False))
vehicle_keys = set(vehicle_dupes[['County Code', 'Municipality Code', 'Department Case Number']].itertuples(index=False))
both = crash_keys & vehicle_keys
print(f"Crashes with both crash and vehicle dupes: {len(both)}")
```

## Smart Merge Framework

### Line Number Tracing

The key innovation enabling smart V/O merging is **line number tracing**:

1. **Observation**: In raw data files, records from UCASE crash appear before records from TCASE crash
2. **Correlation**: V/O records maintain same ordering - vehicles/occupants from UCASE appear before those from TCASE
3. **Accuracy**: **100% correlation** between V/O line order and crash line order
4. **Success rate**: Can identify source crash for **99.8-99.9%** of V/O duplicates

### Merge Strategy

```
For each V/O duplicate pair:
  1. Get crash PK → [(lineno, case_class)] mapping
  2. If crash has UCASE/TCASE pair:
     a. Use V/O line numbers to determine which came from which crash
     b. Keep V/O from TCASE (geocoded/updated version)
  3. Else: fallback to "keep first"
```

### Results Summary

| Entity | Duplicate Groups | TCASE Merges | Fallback | Success Rate |
|--------|-----------------|--------------|----------|--------------|
| Crashes | 2,872 | 1,996 (ucase/tcase) | 876 | 69.5% |
| Vehicles | 3,905 | 2,927 | 978 | **75.0%** |
| Occupants | 4,133 | 2,166 | 1,967 | **52.4%** |

## Implementation

The duplicate handling logic is implemented in:
- `njdot/dupe_utils.py`: Shared utilities for duplicate detection and side-output writing
- `njdot/merge_dupes.py`: UCASE/TCASE merge strategy for crashes (field-level merging)
- `njdot/merge_vo_dupes.py`: Smart merge for vehicles/occupants (crash version-based selection)
- `njdot/crashes.py`: Crash duplicate handling (smart merge)
- `njdot/vehicles.py`: Vehicle duplicate handling (smart merge based on crash version)
- `njdot/occupants.py`: Occupant duplicate handling (smart merge + renumber)
- `njdot/pedestrians.py`: Pedestrian duplicate handling (renumber)

Side-output writing is controlled by the `NJDOT_WRITE_DUPE_OUTPUTS` environment variable.

## Historical Context

Prior to 2023, the NJDOT data (2001-2022) had **zero primary key duplicates**. The 2023 data represents the first significant data quality regression in this dimension. The duplicate patterns and correlations suggest a systemic issue in NJDOT's 2023 data processing pipeline, likely related to:

1. Multiple data submissions from police departments (original + corrected/geocoded versions)
2. Incomplete deduplication in NJDOT's processing pipeline
3. Schema changes or processing errors during 2023 data year

The framework developed here provides tools for investigating similar issues in future years.
