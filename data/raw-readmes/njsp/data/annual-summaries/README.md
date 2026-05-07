# `njsp/data/annual-summaries/` — NJSP fatal-crash annual reports

Primary-source PDFs from NJ State Police's
[Fatal Accident Statistics](https://www.nj.gov/njsp/info/fatalacc/)
page. Two reports per year (`YY` is the 2-digit year, e.g. `23` for
2023):

- **`ptccr_YY.pdf`** — *Preliminary Total Crash Count Report*. One-page
  county-by-county fatality counts (Drivers / Passengers / Pedestrians
  / Bicyclists / Total). Used to backfill pre-2008 NJSP data — the live
  XML feed at `nj.gov/njsp/info/fatalacc/...xml` only covers 2008+, so
  the 2001-2007 county-level numbers in the dashboard come from these
  PDFs.
- **`swfcs2_YY.pdf`** — *Statewide Fatal Crash Summary*. Multi-page
  table of every fatal crash that year, with per-crash victim breakdown
  (driver/passenger/pedestrian/cyclist), date, county, route, and
  cause. Used for cross-checking the XML feed and harmonizing with NJ
  DOT's records.

Both are used by [`njsp/parse-summaries.py`](https://github.com/hudcostreets/nj-crashes)
(via [Tabula](https://tabula.technology/) for table extraction) to
produce the parquet feeds that drive the dashboard's NJSP plots.

## Notebook companions

The repo also has Jupyter notebooks that walk through the parsing —
useful as documentation of how each table was extracted:

- `NJSP summary PDFs.ipynb` — overall extraction pipeline
- `fetch-summaries.ipynb` — original download script (now superseded by
  daily.yml + `dvx import-url --git`)

These notebooks aren't mirrored here; they live alongside the parsed
parquet feeds in the source repo.
