# Backfill per-crash victim types from annual report PDFs

## Problem

The NJSP crashes D1 database has `dk`/`ok`/`pk`/`bk` (driver/passenger/pedestrian/cyclist killed) fields that are NULL for most pre-2020 crashes. The crash table shows grey generic person icons instead of color-coded victim type icons.

However, the annual report PDFs (2007-2024) contain per-crash records with victim type breakdowns. The extraction script (`extract_county_monthly_types.py --raw`) already parses these into structured records with `date`, `cc`, `mc`, `driver`, `passenger`, `cyclist`, `pedestrian` fields.

Currently this data is only used at the aggregate level (county+month) for backfilling `monthly.csv`. The per-crash records are discarded.

## Solution

Match extracted per-crash PDF records to D1 database crashes and update the `dk`/`ok`/`pk`/`bk` columns.

### Match key

Primary: `(cc, mc, datetime)` — county code, municipality code, and datetime.
The extraction script currently captures `date` but not `time` from the PDF.
The PDF lines do contain time — the script needs a small update to also
extract it (the time field is between date and day-of-week in the PDF format:
`Municipality  MM/DD/YYYY  DDD  HH:MM  Road  MP  Persons Killed`).

With datetime matching, same-day-same-muni collisions are resolved.
Fallback for fuzzy matches: `(cc, mc, date)` + victim count (`tk`) as tiebreaker.

### Steps

1. Extract all raw per-crash records:
   ```bash
   python3 www/njsp/data/annual-reports/extract_county_monthly_types.py --raw -o njsp/data/crash_victim_types.csv
   ```

2. Load into the NJSP crashes database and update:
   ```sql
   UPDATE crashes SET
     dk = pdf.driver,
     ok = pdf.passenger,
     pk = pdf.pedestrian,
     bk = pdf.cyclist
   FROM crash_victim_types pdf
   WHERE crashes.cc = pdf.cc
     AND crashes.mc = pdf.mc
     AND DATE(crashes.dt) = pdf.date
     AND crashes.dk IS NULL
   ```

3. Re-export `crashes.db` and import to D1.

### Scope

- ~10K crash records across 2007-2024
- Only updates rows where `dk IS NULL` (doesn't overwrite existing type data)
- Match rate expected to be high (90%+) since both sources come from NJSP

### DVX modeling

This is a one-time backfill, but could be modeled as a DVX stage:
```yaml
# njsp/data/crash_victim_types.csv.dvc
meta:
  computation:
    cmd: python3 www/njsp/data/annual-reports/extract_county_monthly_types.py --raw -o njsp/data/crash_victim_types.csv
    deps:
      www/njsp/data/annual-reports/2008_fatal_crash.pdf: ...
      www/njsp/data/annual-reports/2009_fatal_crash.pdf: ...
      # ... all PDF deps
```

The DB update step would be a side-effect stage depending on the CSV + crashes.db.
