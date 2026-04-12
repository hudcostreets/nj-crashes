# Extend `crashes.parquet` with pre-2008 PDF crashes

## Status (2026-04-12): done

- `njsp/harmonize_pdfs.py`: added `load_pre_xml_crashes()` helper.
- `njsp/cli/update_pqts.py`: after harmonization, concats pre-XML PDF-only
  rows. 4605 rows added (2001-2007); 193 PDF rows dropped due to
  unresolved mc (abbreviated/mislabeled munis — follow-up to improve
  the upstream parser).
- `crashes.parquet`: now spans 2001-2026 with `type_source='pdf-only'`
  for pre-XML rows. IDs for new rows start past the XML-derived max to
  avoid collisions.
- `njsp/cli/update_www_data.py`: added `year-type-county.csv`
  generation (previously maintained by `NJSP summary PDFs.ipynb`);
  now also extends back to 2001. `monthly.csv`, `ytd.csv`,
  `month-year.csv`, `crash-homicide.csv` auto-extended.
- FE: subtitles ("2008–present" → "2001–present"), tick0 / tickvals /
  colorscale `minYear` in `FatalitiesPerYearPlot`,
  `FatalitiesPerMonthPlot`, `FatalitiesByMonthBarsPlot`, `YtdDeathsPlot`,
  `HomicidesComparisonPlot`, `lib/plot.tsx`, and `Home.tsx` updated.
- `njsp/cli/bsky/backfill.py`: filters out `type_source='pdf-only'`
  rows defensively (PDF-only lacks XML URL provenance and time-of-day).
- `update_projections` verified idempotent after the change.

Follow-ups:
- Recover the 193 dropped pre-2008 rows with abbreviation/typo-aware
  muni resolution (e.g. "SO BRUNSWICK TWP" → "South Brunswick Twp").
- Narrative copy in `FatalitiesPerYearPlot`/`plot.tsx` ("worst years
  in the NJSP record (since 2008)") is now slightly stale: 2006 had
  763 deaths, higher than any year 2008-present. Decide whether to
  rewrite or keep the "since 2008" qualifier.
- Optionally parse per-crash time-of-day from PDF `TIME` column
  (currently all pre-2008 rows have `dt` at 00:00).

## Context

`njsp/data/crashes.parquet` currently covers 2008 onward (from FAUQStats XMLs).
After the XML/PDF harmonization (see `specs/done/njsp-pdf-xml-harmonization.md`),
it has per-victim-type columns (`dk`/`ok`/`pk`/`bk`) for all crashes
2008-2024 plus a `type_source` column.

But `www/njsp/data/annual-reports/per_crash_from_pdfs.csv` has **7 more
years** of crash data: 2001-2007 (~4,750 rows), not in any XML feed.
Adding those to `crashes.parquet` would extend every downstream
visualization back to 2001 with no further plumbing.

## Plan

### 1. Add PDF-only rows in `update_pqts`

In `njsp/cli/update_pqts.py`, after the harmonization step:

```python
from njsp.harmonize_pdfs import load_pdf_crashes
pdf = load_pdf_crashes()
pre_xml = pdf[pdf['year'] < earliest_xml_year]
# Build rows matching crashes.parquet schema:
#   cc, mc, dt (date at midnight; no time-of-day), tk, ti (NA),
#   dk, ok, pk, bk, location (NA), street (NA), highway (NA),
#   type_source = 'pdf-only'
crashes = pd.concat([pre_xml_rows, crashes]).sort_values('dt')
```

- `dt`: `Timestamp(date)` with no time (or synthetic 00:00). Flag this
  in a column so plots can distinguish if needed.
- `location`/`street`/`highway`: NA. PDF has raw `"Road MP"` text — could
  populate `location` with that if useful later.
- `type_source`: new value `'pdf-only'` (distinct from `'pdf'` which
  means "XML record, types from PDF").
- Row id: continue the existing integer index; ensure no collisions
  with XML IDs.

### 2. Verify downstream rebuilds

- `update_www_data.py` will pick up the new years automatically.
- Check output CSVs (`monthly.csv`, `year-type-county.csv`,
  `crash-homicide.csv`, `ytd.csv`) now have 2001-2007 rows.
- `update_projections` only uses recent years — verify no regression.

### 3. Plot component updates

Most plots auto-adapt to the new range. Explicit changes likely needed:

- `HomicidesComparisonPlot`: starts at 2008; extend back to 2001.
- `FatalitiesPerYearPlot`: x-axis auto-scales, but year-labels may
  need adjusting if default range is hard-coded.
- Check for any hard-coded `2008` constants across `www/src/njsp/`.

### 4. Schema considerations

`type_source` currently has values `xml`, `pdf`, `unresolved`. Add
`pdf-only` for pre-2008 rows (or reuse `pdf` and infer via
`NULL location`). `pdf-only` is more explicit and easier to filter.

Add a nullability guarantee: `dt`, `cc`, `mc`, `tk`, `dk`, `ok`, `pk`,
`bk`, `type_source` are never NULL in the harmonized output.

## Open questions

- NJSP published PDFs earlier than 2001 (at least to the mid-1990s).
  Leave as a follow-up (format analysis + collection).
- Should pre-2008 `dt` include a time-of-day? PDF has it (`TIME`
  column, e.g. `0930`). Could parse and populate, with provenance.
- The Bluesky backfill (`njsp/cli/bsky/backfill.py`) reads
  `crashes.parquet` — verify it ignores PDF-only crashes (they're
  from before Bluesky existed) or gate on date.

## Out of scope

- Pre-2001 PDFs.
- Per-crash road/mp parsing from PDF's free-text column.
