# Parse all years' NJSP annual report PDFs

## Background

NJSP publishes two types of PDFs per year:
- **Full annual reports** (e.g. `2019_fatal_crash_report.pdf`): per-crash records including county, municipality, road, victim type
- **Summary PDFs** (`ptccr_YY.pdf`): aggregate {year, type, county} totals only

The per-crash XMLs (`FAUQStats*.xml`) only include victim type fields (`dk`/`ok`/`pk`/`bk`) since 2020. Pre-2020, those fields are `<NA>`.

Currently, the summary PDFs are the only source of pre-2020 victim type breakdowns, but they only provide year × type × county aggregates — no per-month or per-municipality granularity.

## Current State (2026-04)

All full annual report PDFs are present under `www/njsp/data/annual-reports/`, covering **2001–2024** (24 years) across three filename conventions:
- `fatalacc_YYYY.pdf`: 2001–2005
- `fatalcrash_2006.pdf`: 2006
- `YYYY_fatal_crash.pdf`: 2007–2015
- `YYYY_fatal_crash_report.pdf`: 2016–2024

PDFs are DVC-tracked (`.dvc` sidecars committed; PDFs gitignored).

### Existing parsers (committed under `www/njsp/data/annual-reports/`)

- **`extract_monthly_types.py`** — parses statewide Section A ("Victim Classification by Month"). Output: `monthly_types_from_pdfs.csv` (288 rows = 24 years × 12 months). **Covers 2001–2024.**
- **`extract_county_monthly_types.py`** — parses per-crash listing ("Fatal Crashes by County, Municipality, Date, Time and Location"), aggregates to county+month and county+muni+month. Outputs `county_monthly_types_from_pdfs.csv` (3751 rows) and `muni_monthly_types_from_pdfs.csv` (8959 rows). **Covers 2007–2024 only.**
- **`extract_county_monthly_types_ocr.py`** — OCR fallback (for PDFs where text extraction fails).
- **`validate_monthly_types.py`** — cross-validates PDF-extracted monthly types against `crashes.parquet` for 2020+.

### Gap: 2001–2006 per-crash data

`extract_county_monthly_types.py` misses 2001–2006 because:
1. Its glob (`*_fatal_crash*.pdf`) doesn't match `fatalacc_*.pdf` or `fatalcrash_2006.pdf`.
2. Its section detector requires `'FATAL CRASHES BY COUNTY'`, but 2001–2005 reports use `'FATAL ACCIDENTS BY COUNTY'`.

Otherwise the per-crash row format (`MUNI DATE DAY TIME ROAD MP PERSONS_KILLED`) is identical in 2001–2006 (verified in 2001 and 2006 PDFs).

## Remaining work

1. **Extend `extract_county_monthly_types.py`** to cover 2001–2006:
   - Update glob to include `fatalacc_*.pdf` and `fatalcrash_*.pdf`.
   - Accept `'FATAL ACCIDENTS BY COUNTY'` as an alternate section header.
   - Verify section-end detection still works (different tail sections in pre-2007 reports).
   - 2006's PDF has CID-encoded legend text; confirm data rows still extract cleanly.

2. **Regenerate outputs** and spot-check year totals against `fatalities_by_year_by_county.tsv` / `monthly_types_from_pdfs.csv` (Section A is known-good for 2001–2024).

3. **Run `validate_monthly_types.py`** (currently only validates 2020+; extend to cross-check pre-2020 totals against Section A totals and summary PDFs where available).

## Future: use parsed data for frontend

Once 2001–2006 per-crash data is available, the downstream wins are:
- Per-month type breakdowns pre-2020 (currently only statewide)
- Per-municipality type breakdowns pre-2020
- `year-type-county.csv` / `year-type.csv` from summary PDFs could be regenerated from the richer per-crash data (or kept as a QA cross-check).

## Open questions

- Can the cross-year data be merged into or validated against `crashes.parquet`, filling in the type fields for pre-2020 crashes? (The XMLs lack `dk`/`ok`/`pk`/`bk` pre-2020 — joining on date+county+muni might work but muni-name matching will need the same normalization logic as in the existing parser.)
