# Backfill missing lat/lon for fatal crashes via NJSP `LOCATION` parsing

## Landed

Commit: `Backfill fatal lat/lon via NJSP LOCATION parsing (#78)`.

- New CLI: `njdot backfill_geocodes` writes `crashes_geocode_backfill.parquet`.
- `load_crashes_with_aashto` merges the sidecar inline (filling NaN
  `(sri, mp, ilat, ilon)` per `(year, cc, mc, case)`).
- Coverage: 616 / 2,165 (28%) of map-missing fatals recovered.
- v2 hex pyramid rebuilt + S3 sync.
- Cells-api R2 pyramid: rebuild via `dvx run data/cells/{raw,pyramid}.dvc` + `njdot compute cells push`.
- Test case `18-002062` (Newark Ave & 7th, Jersey City, 2018-01-27) lands at MP 0.75 → (40.726989, -74.053497).

## What already exists

`Crashes.mp_lls()` (`njdot/crashes.py:459`) interpolates `(ilat, ilon)`
from `(df.sri, df.mp)` via `geocode_mp` + `get_mp05_map()`. The map
already prefers `oi{lat,lon}` (original w/ interp fallback), so any row
with a populated `sri`/`mp` already gets placed.

**This spec is the upstream gap**: many NJDOT fatals have `sri=NaN,
mp=NaN` (and `olat=NaN, olon=NaN`), so `mp_lls` produces NaN too.

## Problem

`njdot/data/crashes.parquet` carries `olat/olon` for only ~46% of fatal
crashes 2001-2023. Worst years: **2001-02, 2011-13, 2015-16** all 100%
missing; 2017-22 in the 50-60% range; 2010 at 71%. **7,557 of 14,037
fatals (54%) cannot be placed on the map.**

NJSP's `crash-log.parquet` covers the same crashes (and earlier; carries
2001-present statewide fatals) but never had lat/lon at all — only
`STREET` / `HIGHWAY` / `LOCATION` strings and SRI-like MP descriptors
(e.g., "Newark Ave E MP .74").

Discovered when investigating user-reported missing fatal near Newark Ave
& 7th in Jersey City, 2018-01-27:
- NJDOT `case=18-002062`: `road=NEWARK AVE`, `cross_street=SEVENTH STREET`, `olat/olon=NaN`
- NJSP `accid=8518`: `STREET=Newark Ave`, `LOCATION="Newark Ave E MP .74"`
- Both data sources agree the crash happened; neither has coordinates.

## Lookup target

`njdot/data/nj_mp_tenths.parquet` carries 896k tenth-mile MP rows with
`(SRI, SLD_NAME, Second_Name, MP, lon, lat)`. For Newark Ave MP 0.75 in
Jersey City: `(40.726989, -74.053497)` — exactly the corner of 7th St.

So **`(road, mp)` → `(lat, lon)`** via MP-table fuzzy match.

## Inputs

Per-fatal candidate keys (in order of confidence):
1. **NJDOT side**: `road` + (cross-street → MP via reverse-MP-lookup, see below); or `road` + recorded `mp` if NJDOT carries it for some years.
2. **NJSP side**: parse `LOCATION` string. Most NJSP fatals have a `... MP X.YY ...` suffix. Mine the MP number from the regex; resolve `STREET`/`HIGHWAY` to `SLD_NAME` via simple normalize+exact match (e.g., "Newark Ave" → "NEWARK AVE").

NJDOT and NJSP cover the same crashes; the harmonized matcher
(`njsp/data/njsp_njdot_match.parquet`) links them. So when NJDOT has
`road + cross_street` but no MP, we can pull NJSP's MP from the matched
NJSP row.

## Algorithm sketch

1. Restrict to fatals with NaN `olat/olon`. Join in NJSP-matched record
   for MP enrichment.
2. For each candidate `(road, mp, muni)`:
   - Normalize road string (uppercase, strip suffixes like "AVE"/"AVENUE")
   - Filter MP table to matching `SLD_NAME` (or `Second_Name` fallback)
   - Within the muni (filter MP rows whose `(lat, lon)` is inside the
     muni polygon, using the existing `Municipal_Boundaries_of_NJ.geojson`)
   - Pick the MP row whose `MP` is closest to the target
   - Set `olat = matched.lat`, `olon = matched.lon`
3. Backfill quality flag: add `geocode_source` column ("raw" | "mp_match")
   so downstream filters can opt to show only raw-geocoded if needed.

## Cross-street fallback

For rows with `road + cross_street` but no MP and no NJSP match (rare):
- Intersection of two SLD_NAME polylines → can compute, but heavier
  (would need MP polyline geometry, not just point samples).
- Defer; cover with `mp_match` first.

## Scope

- CLI: `njdot backfill-geocodes` (new subcommand) writing back to
  `crashes.parquet` (or a sidecar with `id → (lat, lon, geocode_source)`).
- DVX stage: feed crashes.parquet dep chain. Re-runs whenever MP table
  or per-table parquets change.
- Estimated coverage: most 2001-02, 2011-13, 2015-16 fatals carry road
  + MP-ish location strings in NJSP, so likely 80%+ of the 7.5k gap.

## Verification

- Sample 20 known-coords fatals, hide their lat/lon, run backfill, check
  match within ~50m.
- Spot-check Newark Ave & 7th (case 18-002062) lands at the right corner.

## Not in scope

- Geocoding injury/PDO crashes (much larger set; map shows them, but
  the strict fatal misses are the priority).
- Reverse-geocoding from cross-street intersection geometry.
- NJSP-only crashes that NJDOT lacks entirely (different problem; the
  harmonization matcher handles those separately).
