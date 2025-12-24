# NJ Crashes Roadmap

## Completed

### 2023 NJDOT Data Integration ✅
- Downloaded and processed 2023 crash data (Accidents, Drivers, Vehicles, Occupants, Pedestrians)
- Combined parquets now contain 2001-2023 (6M+ crashes)
- SQLite databases regenerated with 2023 data
- `cmymc.db` aggregation tables updated

### DVX Migration ✅
- Migrated from DVC pipelines (`dvc.yaml`) to DVX (decentralized `.dvc` files with `meta.computation`)
- 131 output files tracked with provenance
- CLI wrappers for notebook execution (`njsp update_cmymc`, `njsp harmonize_muni_codes`, etc.)

### Code Cleanup ✅
- Migrated notebook execution to `juq` (from local `nj_crashes/utils/nb.py`)
- Removed stale `cmym.db`, renamed to `cmymc.db` for consistency
- Cleaned up DVX `.dvc` files (removed `env -u PYTHONPATH`, deprecated `code_ref`)

## In Progress

### Verify 2023 in Web UI
- [ ] Boot local dev server, confirm 2023 data appears in charts/tables
- [ ] Check county/muni aggregations include 2023

## Planned

### Frontend: Migrate to Vite
- Current: Next.js
- Target: Vite + React
- Benefits: Faster builds, simpler config, better for static site

### Backend: Cloud Functions API
- Serve individual crash details (currently only aggregations available)
- Endpoints:
  - `GET /crash/:id` - Full crash record with vehicles, occupants, pedestrians
  - `GET /crashes?lat=...&lon=...&radius=...` - Geo queries
  - `GET /crashes?sri=...&mp=...` - Location-based queries

### NJSP ↔ NJDOT Harmonization
- **Goal**: Link NJSP fatal crashes to corresponding NJDOT records
- **Approach**:
  1. Match on date + location (lat/lon or SRI/milepost)
  2. Validate with victim counts, vehicle counts
  3. Create unified crash ID mapping table
- **Outputs**:
  - Canonical endpoint for each crash (whether from NJSP or NJDOT)
  - Merged view combining NJSP real-time updates with NJDOT detail
  - Coverage analysis: which NJSP fatals have NJDOT matches?

### Data Quality
- [ ] Investigate 2023 duplicate crash records (see `njdot/DUPLICATES.md`)
- [ ] Document municipality code edge cases

## Future Ideas

- Historical trend analysis (20+ years of data)
- Crash clustering / hotspot detection
- Integration with road geometry data
- Pedestrian/cyclist safety analysis
- Comparison with other states' data
