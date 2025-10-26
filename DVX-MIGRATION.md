# NJDOT DVX Migration Design

## Current State: DVC Setup

### File Counts
- **1256** total `.dvc` files in `njdot/data/`
- **1145** `.zip.dvc` files (raw imports from NJDOT website)
- **110** `.pqt.dvc` files (per-year statewide parquets, 2001-2022)
- **1** `.txt.dvc` file

### Structure by Year

| Years     | zip.dvc | pqt.dvc | Notes |
|-----------|---------|---------|-------|
| 2001-2021 | ~30     | 5       | Per-county zips + statewide parquets |
| 2022      | 5       | 5       | Statewide zips only + statewide parquets |
| 2023      | 110     | **0**   | Per-county zips, parquets via `dvc.yaml` |

### Key Observation
2023 is the only year where parquets are generated via `dvc.yaml` stages rather than tracked as static `.dvc` files. This is the migration target.

## Current DAG Structure

```
                                    ┌─────────────────────────┐
                                    │  NJDOT Website          │
                                    │  (raw ZIP downloads)    │
                                    └───────────┬─────────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │ {County}2023      │       │ {County}2023      │       │ {County}2023      │
        │ Accidents.zip     │       │ Drivers.zip       │       │ Vehicles.zip      │
        │ (21 counties)     │       │ (21 counties)     │       │ (21 counties)     │
        └─────────┬─────────┘       └─────────┬─────────┘       └─────────┬─────────┘
                  │                           │                           │
                  │ rawdata txt               │                           │
                  │ (unzip)                   │                           │
                  ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │ NewJersey2023     │       │ NewJersey2023     │       │ NewJersey2023     │
        │ Accidents.txt     │       │ Drivers.txt       │       │ Vehicles.txt      │
        │ (concatenated)    │       │                   │       │                   │
        └─────────┬─────────┘       └─────────┬─────────┘       └─────────┬─────────┘
                  │                           │                           │
                  │ rawdata pqt               │                           │
                  │ (parse + geocode)         │                           │
                  ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │ NewJersey2023     │       │ NewJersey2023     │       │ NewJersey2023     │
        │ Accidents.pqt     │       │ Drivers.pqt       │       │ Vehicles.pqt      │
        └─────────┬─────────┘       └─────────┬─────────┘       └─────────┬─────────┘
                  │                           │                           │
                  │    njdot compute pqt      │                           │
                  │    (combine 2001-2023)    │                           │
                  ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │ crashes.parquet   │       │ drivers.parquet   │       │ vehicles.parquet  │
        │ (6.6M rows)       │       │ (10.7M rows)      │       │ (11.8M rows)      │
        │                   │       │                   │       │                   │
        │ + crash_pk_       │       │                   │       │                   │
        │   mappings.pqt    │       │                   │       │                   │
        └─────────┬─────────┘       └─────────┬─────────┘       └─────────┬─────────┘
                  │                           │                           │
                  │ njdot compute db          │                           │
                  ▼                           ▼                           ▼
        ┌───────────────────┐       ┌───────────────────┐       ┌───────────────────┐
        │ crashes.db        │       │ drivers.db        │       │ vehicles.db       │
        │ (2.6 GB)          │       │ (1.1 GB)          │       │ (1.2 GB)          │
        └───────────────────┘       └───────────────────┘       └───────────────────┘

        (Same pattern for Occupants, Pedestrians)
```

## DVX Migration Design

### Target: Decentralized `.dvc` Files with `meta.computation`

Each output file will have a self-contained `.dvc` file with:
- `outs`: MD5 hash and size
- `meta.computation.cmd`: Command to regenerate
- `meta.computation.deps`: Input file hashes
- `meta.computation.code_ref`: Git commit of code used

### Phase 1: 2023 Raw → Parquet (Proof of Concept)

Convert the 5 `raw_2023_*` DVC stages to DVX format:

**Before (dvc.yaml):**
```yaml
raw_2023_accidents:
  cmd: env -u PYTHONPATH rawdata pqt -r NJ -y 2023 -t accidents
  deps:
    - njdot/data/2023/NewJersey2023Accidents.zip
  outs:
    - njdot/data/2023/NewJersey2023Accidents.pqt
```

**After (njdot/data/2023/NewJersey2023Accidents.pqt.dvc):**
```yaml
outs:
  - md5: 6e058a16f38835041df9d14485150f57
    size: 12124133
    hash: md5
    path: NewJersey2023Accidents.pqt
meta:
  computation:
    cmd: env -u PYTHONPATH rawdata pqt -r NJ -y 2023 -t accidents
    code_ref: <git-commit-sha>
    deps:
      njdot/data/2023/NewJersey2023Accidents.zip: af1756f11fb5caeab007d9b9683d77b9
```

### Phase 2: Combined Parquets

```yaml
# njdot/data/crashes.parquet.dvc
outs:
  - md5: 4d56ec989865608563225eb8f84cef74
    size: 306762269
    hash: md5
    path: crashes.parquet
meta:
  computation:
    cmd: env -u PYTHONPATH njdot compute pqt -t crashes
    code_ref: <git-commit-sha>
    deps:
      njdot/data/2001/NewJersey2001Accidents.pqt: 9e5d8dc82b9a430856622577a8ed077a
      njdot/data/2002/NewJersey2002Accidents.pqt: <md5>
      # ... all 23 years
      njdot/data/2023/NewJersey2023Accidents.pqt: 6e058a16f38835041df9d14485150f57
```

### Phase 3: SQLite Databases

```yaml
# www/public/njdot/crashes.db.dvc
outs:
  - md5: 24b9017c21f885d01a5bf030e7b3f824
    size: 2630090752
    hash: md5
    path: crashes.db
meta:
  computation:
    cmd: env -u PYTHONPATH njdot compute db -t crashes
    code_ref: <git-commit-sha>
    deps:
      njdot/data/crashes.parquet: 4d56ec989865608563225eb8f84cef74
```

## Commands

### Convert Existing DVC Stages to DVX

1. **Run computation** (already done via `dvc repro`):
   ```bash
   rawdata pqt -r NJ -y 2023 -t accidents
   ```

2. **Add output with provenance**:
   ```bash
   dvx add njdot/data/2023/NewJersey2023Accidents.pqt \
     --dep njdot/data/2023/NewJersey2023Accidents.zip \
     --cmd "env -u PYTHONPATH rawdata pqt -r NJ -y 2023 -t accidents"
   ```

3. **Or use `dvx run`** if computation definition exists in .dvc file

### Verify Freshness

```bash
dvx status njdot/data/2023/
dvx status njdot/data/crashes.parquet
dvx status www/public/njdot/crashes.db
```

## Migration Steps

1. **Delete `dvc.yaml` and `dvc.lock`** (or keep for backwards compatibility initially)

2. **Create DVX .dvc files** for each computed output:
   - 5 `NewJersey2023{Type}.pqt.dvc` files
   - 5 `{tbl}.parquet.dvc` files in `njdot/data/`
   - 1 `crash_pk_mappings.parquet.dvc` file
   - 5 `{tbl}.db.dvc` files in `www/public/njdot/`

3. **Update CI/CD** to use `dvx run` instead of `dvc repro`

## Benefits of DVX Over DVC Pipelines

1. **Self-contained provenance**: Each output knows exactly how it was created
2. **Parallel execution**: Independent artifacts run concurrently
3. **Git-friendly**: Changes to one artifact don't touch other files
4. **No lock contention**: Multiple processes can add artifacts simultaneously
5. **Decentralized**: No single `dvc.yaml` bottleneck

## Files to Migrate

| Current (dvc.yaml stage) | New DVX .dvc file |
|--------------------------|-------------------|
| `raw_2023_accidents` | `njdot/data/2023/NewJersey2023Accidents.pqt.dvc` |
| `raw_2023_drivers` | `njdot/data/2023/NewJersey2023Drivers.pqt.dvc` |
| `raw_2023_vehicles` | `njdot/data/2023/NewJersey2023Vehicles.pqt.dvc` |
| `raw_2023_occupants` | `njdot/data/2023/NewJersey2023Occupants.pqt.dvc` |
| `raw_2023_pedestrians` | `njdot/data/2023/NewJersey2023Pedestrians.pqt.dvc` |
| `combined_crashes` | `njdot/data/crashes.parquet.dvc` |
| `combined_drivers` | `njdot/data/drivers.parquet.dvc` |
| `combined_vehicles` | `njdot/data/vehicles.parquet.dvc` |
| `combined_occupants` | `njdot/data/occupants.parquet.dvc` |
| `combined_pedestrians` | `njdot/data/pedestrians.parquet.dvc` |
| (implicit) | `njdot/data/crash_pk_mappings.parquet.dvc` |
| `db_crashes` | `www/public/njdot/crashes.db.dvc` |
| `db_drivers` | `www/public/njdot/drivers.db.dvc` |
| `db_vehicles` | `www/public/njdot/vehicles.db.dvc` |
| `db_occupants` | `www/public/njdot/occupants.db.dvc` |
| `db_pedestrians` | `www/public/njdot/pedestrians.db.dvc` |
