# NJSP PDF ↔ XML Harmonization

Analysis of how NJSP's two public fatal-crash data sources agree, and a proposal
for a canonical harmonized dataset.

## Sources

1. **FAUQStats XMLs** — `njsp/data/FAUQStats{year}.xml`; updated daily. One record
   per crash with `cc`, `mc`, `dt`, `tk` (total killed) and — from 2020 on — type
   breakdown fields `dk`, `ok`, `pk`, `bk` (driver / occupant / pedestrian /
   bicyclist killed). Published via the NJSP feed at
   https://www.njsp.org/info/fatalacc/ .
2. **Annual report PDFs** — `www/njsp/data/annual-reports/*.pdf`; published once
   per year. Each PDF contains:
   - Section A: statewide by-month victim classification
   - Section B: statewide by-month accident & fatality counts
   - per-crash listing: county-grouped table of every fatal crash

The project currently builds `njsp/data/crashes.parquet` from the XMLs only.

## Agreement between sources

All comparisons below use the fixed parsers in
`www/njsp/data/annual-reports/extract_*.py`.

|Check                                              |Result|
|---|---|
|Annual crash count (XML vs per-crash PDF rows)     |**Exact match** every year 2008–2024|
|Annual fatality total (XML `tk` vs per-crash sum)  |**Exact match** every year 2008–2024|
|Monthly type totals 2020+ (XML vs Section A)       |**Exact match** every month|
|Per-day crash count 2020+ (XML vs per-crash)       |Match except 2 days in 2022 where one crash is date-shifted by ±1 day between sources|
|Per-day type breakdown 2020+                       |Match except the same date-shift in 2022|
|XML `tk` vs Section A annual totals                |Match except 2016 (XML/per-crash: 602; Section A: 603)|

## Internal NJSP inconsistencies

Documented in detail in
[`specs/njsp-pdf-data-quality.md`](./njsp-pdf-data-quality.md). Summary:

- 2001–2005: 15 (year, month) cells where Section A's by-type totals do not
  match the per-crash listing in the same PDF. Totals often match; the
  disagreement is in how individual victims are classified (driver vs
  passenger, driver vs pedestrian).
- 2016 November: Section A reports 52 fatalities; the per-crash listing and
  the XML feed both have 51. Section A is the outlier.
- 2003 April: Section B claims 47 accidents; the per-crash listing has 46
  rows. The PDF's own tables disagree on the number of April crashes.
- 2022-06-17 / 2022-06-18: a single Bergen crash (Englewood City, SH 4
  MP 8.8) is listed on 06-17 in the XML feed and 06-18 in the PDF.

For every crash count or fatality count check, the **XML feed agrees with
the fixed per-crash listing**. Where the PDF's Section A disagrees, Section A
is the outlier.

## Proposed canonical dataset

Make `njsp/data/crashes.parquet` the output of a harmonization step rather
than a direct XML dump:

1. **Load XML records** (current behavior) as the primary source.
2. **Load per-crash PDF records** using `extract_county_monthly_types.py`.
3. **Join on `(date, cc, mc)`** (or `(date, county, muni)` via the existing
   `_normalize_pdf_muni` logic) and verify 1:1 correspondence.
4. **Emit a single harmonized record per crash** with fields from both
   sources plus a provenance column (`xml_id`, `pdf_row`) and a `_diffs`
   column listing any field-level disagreements.
5. **Fail the build** (or log warnings) if any crash exists in one source
   but not the other, or if the number of diffs exceeds a small threshold.

Downstream consumers (`crashes.py`, `monthly.csv`, etc.) continue to read
`crashes.parquet` unchanged — the harmonization is an implementation
detail.

### Type backfill for pre-2020 crashes

XML records lack `dk`/`ok`/`pk`/`bk` before 2020. The per-crash PDF listings
have that information back to 2001. Once the sources are joined 1:1, we can
backfill those fields in the harmonized dataset. This enables:

- Per-month type breakdowns pre-2020 (currently only Section A has these,
  and it's statewide-only).
- Per-municipality type breakdowns for all years 2001–2024.

### Harmonization overrides

For the ~20 cells where the per-crash listing disagrees with Section A, an
explicit override table (checked into the repo) can document which value
is authoritative. For now, **the per-crash listing is authoritative for
individual crash records**, because:

- XML (also per-crash) always agrees with the per-crash listing on totals.
- When XML type breakdowns are available (2020+), they always match the
  per-crash listing.
- Section A is demonstrably wrong in at least one case (2016-11).

## Open questions for NJSP

Same as in [`njsp-pdf-data-quality.md`](./njsp-pdf-data-quality.md), plus:

- For the 2022 Bergen/Englewood pedestrian crash, which date is correct —
  06-17 (XML feed) or 06-18 (PDF)?
- Are the XMLs and the PDFs generated from a common source system? If so,
  is there a snapshot timestamp or version ID that would let us identify
  which is newer?
- Pre-2020 XMLs lack per-victim type fields. Is the information available
  upstream and could the feed be updated to include it historically?
