# Remove redundant aggregate-PDF backfill from `update_www_data.py`

## Context

`njsp/cli/update_www_data.py` currently does a post-hoc backfill of
pre-2020 type breakdowns into the generated monthly CSVs:

```python
MONTHLY_TYPES_BACKFILL = 'www/njsp/data/annual-reports/monthly_types_from_pdfs.csv'
COUNTY_MONTHLY_TYPES_BACKFILL = '.../county_monthly_types_from_pdfs.csv'
MUNI_MONTHLY_TYPES_BACKFILL = '.../muni_monthly_types_from_pdfs.csv'
```

After computing monthly aggregates from `crashes.parquet`, it iterates
through these three PDF-derived CSVs and overwrites the `driver`,
`passenger`, `pedestrian`, `cyclist` fields for rows where the
computed value was 0 — on the assumption that 0 means "XML lacked
types, trust the PDF aggregate".

This was necessary before the harmonization (see
`specs/done/njsp-pdf-xml-harmonization.md`) because pre-2020 crashes
in `crashes.parquet` had NA types.

## Problem

Now that `crashes.parquet` has types for every crash 2008-2024 (XML
natively for 2020+, PDF-backfilled per-crash for 2008-2019), the
post-hoc aggregate backfill is redundant — and subtly wrong for
rows where the correct value genuinely is 0 for one type (those
would be overwritten if the PDF aggregate had a nonzero value there,
but in practice PDF agrees with per-crash sum so this doesn't matter).

## Plan

1. Delete the backfill block in `update_www_data.py` (~40 lines:
   the three `MONTHLY_TYPES_BACKFILL` loops and their CSV loads).
2. Run `njsp update_www_data` and diff the output `monthly.csv`
   against the previous version. Expected: identical, byte-for-byte,
   for every year 2008-2024. Any diffs reveal an edge case where
   the aggregate-PDF CSV was being used to paper over a per-crash
   harmonization gap — investigate before removing.
3. Remove the three `_BACKFILL` path constants at the top of the
   file if no longer referenced.
4. Confirm the PDF-derived aggregate CSVs are still useful for
   other purposes (sanity checks, historical reference). They're
   produced from the same source data as the per-crash CSV and
   harmonization relies on them indirectly, so keep regenerating
   them.

## Out of scope

- Regenerating the annual-report CSVs from `crashes.parquet` (reverse
  direction — would break the independence of the two sources which
  makes data-quality cross-checks possible).
- Deleting `monthly_types_from_pdfs.csv` etc. (they're still used by
  `validate_monthly_types.py` and for the data-quality writeup).

## Test plan

- Regenerate `monthly.csv`, `ytd.csv`, `month-year.csv`,
  `year-type-county.csv` with and without the backfill block.
- Diff should be empty.
- CI `validate_monthly_types.py` should still pass.
