# Geocoding pipeline audit: SRI/MP refresh + unmapped-crash QC

Goal: audit and refresh the SRI-MP geocoding pipeline that interpolates lat/lon for NJDOT crashes, then produce QC stats and (if needed) improve coverage.

## Status quo

Stack (as of 2026-04-21):

- `nj_sri_mp.db` (SQLite, 34.5 MB, **mtime 2023-10-19**, ~2.5 years old)
  - Table `sri_mp(SRI, MP, LON, LAT)`, 517,945 rows, 29,713 distinct SRIs
  - **Not git-tracked, not DVX-tracked** — lives only on one laptop
- Source: NJDOT ArcGIS "New Jersey Standard Route Id And Milepost" FeatureServer:
  `https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0/query`
- Scrape path: `nj_crashes/sri/cli.py::fetch_sri_mps(sri)` — per-SRI paginated query, cached to `.sri/{sri}` JSON files
- Aggregation: `nj_crashes/sri/mp05.py::get_mp05_map()` loads entire SQLite into `SriMap` for O(1) lookups
- Consumer: `njdot/crashes.py::lls()` adds `ilat`/`ilon` to each crash via SRI+MP interpolation
- Output: `crashes.parquet` has `olat/olon` (original from report) + `ilat/ilon` (interpolated). Current pipeline prefers `ilat` fallback `olat`.

## Coverage today (6.57M crashes, 2001-2023)

```
Per-year (any lat/lon):
 2001: 39.6%   2008: 56.3%   2015: 59.0%   2020: 88.7%
 2002: 44.2%   2009: 54.7%   2016: 60.1%   2021: 87.5%
 2003: 54.6%   2010: 51.9%   2017: 68.4%   2022: 89.7%
 2004: 55.6%   2011: 51.2%   2018: 72.9%   2023: 93.5%
 2005: 55.2%   2012: 50.8%   2019: 82.6%
 2006: 58.5%   2013: 50.2%
 2007: 58.2%   2014: 53.6%

Per-severity:
  fatal:  83.1%    injury:  69.3%    PDO:  58.6%
```

`olat/olon` vs `ilat/ilon` agreement (1.35M rows with both):

- Median delta: 28m — good
- P90: 8.9 km — some drift (probably coord-system confusion in some years' raw data)
- P95+: 12,000+ km — clearly nonsense `olat` values (pipeline should drop these)

## Issues to address

1. **SRI DB age (2.5 years)**: NJDOT adds new routes + adjusts MPs over time. 2024/2025 crashes may reference SRIs not yet in the DB. Refresh from ArcGIS.
2. **Untracked data**: `nj_sri_mp.db` should be DVX-tracked so other machines can use the pipeline (and the refresh is reproducible).
3. **Unmapped crash analysis**: why are 6-17% of recent crashes unmapped?
   - Missing SRI in crash report (common on local streets)
   - SRI present but not in our DB (pipeline gap)
   - SRI present, MP out of range
   - SRI present, MP rounds to a 0.05-increment not in the grid
4. **Olat outliers**: some `olat` values are clearly wrong (0, garbage). Detect and drop.

## Work items

### 1. Refresh SRI DB (turnkey)

```bash
# Re-scrape all known SRIs
sri mps -o
# Or targeted: scrape only SRIs referenced in 2024/2025 crashes (once those land)
```

Expected runtime: 29K SRIs × 500ms sleep ≈ 4 hours. Can run in background. Produces updated `.sri/*` cache + regenerated `nj_sri_mp.db`.

**DVX-track the output**:
```yaml
# nj_sri_mp.db.dvc
outs:
  - path: nj_sri_mp.db
meta:
  computation:
    cmd: sri mps --sync
    deps: []   # external data source (ArcGIS); no local deps
```

Add manifest of source ArcGIS URL + scrape date + SRI count + MP count in a companion metadata file.

### 2. Unmapped-crash QC script

`njdot/cli/geocode_qc.py`:

For each crash with `(ilat, ilon) = (NaN, NaN)`:

- Does it have `sri` and `mp`? If both missing → "no-sri-mp" (expected: local-road crash).
- `sri` present but not in `nj_sri_mp.db`? → "sri-missing" (DB gap — report these back to SRI-refresh pipeline).
- `sri` + `mp` present, SRI in DB, but MP out of range? → "mp-out-of-range".
- `sri` + `mp` present, MP in range but rounds to a 0.05 increment not in grid? → "mp-granularity".

Output a parquet `njdot/data/geocode-qc.parquet` with per-crash failure mode + aggregates per (year, cc, mc, reason).

### 3. Olat sanity-check

- Drop `olat`/`olon` when outside NJ bbox (~`[-75.6, 38.9, -73.9, 41.4]`) or `(0, 0)` or `NaN`.
- Pipeline: add sanitization in `njdot/rawdata/pqt.py` (raw-read stage) or `njdot/crashes.py` (post-load).
- Invalidate cached `crashes.parquet` after fix.

### 4. Alternative geocoders for unmapped crashes

For the ~10% of recent crashes with no SRI/MP:

- They often have `road` (street name), `municipality`, `cross_street` fields.
- Could run a batch geocoder (Nominatim / local Photon / ArcGIS Census TIGER) against these.
- Scope: maybe 30K/year × 20% = 60K/year unmapped → 500K-1M lookups over 2001-2023. Doable with a local Nominatim (OSM data).

### 5. Coverage regression tests

- Per-year coverage should only improve over time as the pipeline matures.
- Add a `test_geocode_coverage.py` that asserts no year's coverage drops by > 1pp vs a baseline.

## Staging

1. (fast) Olat sanity-check — pure code change, ~20 lines. Low risk. Do this now.
2. (medium) SRI DB refresh — kick off as background task (4 hr).
3. (medium) Unmapped-crash QC script + report.
4. (post-forum, stretch) External geocoder for remaining unmapped.
5. (post-forum) DVX-track the DB + automate refresh in the daily pipeline.

## Open questions

- How often does NJDOT update the ArcGIS SRI feed? Monthly? Annually? Should the refresh be part of daily.yml or a separate cron?
- Any municipalities maintain their own SRI-like indexes for local roads? (probably not; NJDOT covers state routes primarily)
- Should we fall back from `ilat` to `olat` silently (current behavior) or explicitly distinguish in the output for downstream QA?

## References

- SRI API: https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0
- Scrape logic: `nj_crashes/sri/cli.py:fetch_sri_mps`
- DB reader: `nj_crashes/sri/mp05.py`, `nj_crashes/sri/sri_map.py`
- QC stats output: `tmp/geocode-qc.txt`
