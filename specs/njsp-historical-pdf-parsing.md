# NJSP historical PDF parsing

## Context

NJSP publishes fatal crash statistics as a web page with data going back to 2008. But NJSP has published annual fatal crash reports as PDFs going back further — at least to the early 2000s, possibly earlier. These PDFs contain per-county breakdowns that would let county-level pages show longer time series (e.g. homicides-comparison plot currently starts at 2008).

## Goals

1. Find and collect historical NJSP fatal crash PDFs (pre-2008)
2. Parse them into structured data matching the existing NJSP schema
3. Extend county-level fatal crash time series back as far as data exists

## Plan

### 1. Source collection

- Search NJSP website and Wayback Machine for historical fatal crash reports
- Check NJ State Library / government archives
- Look for annual reports titled "Fatal Crash Statistics" or "Fatal Motor Vehicle Crash Report"
- Download and mirror all found PDFs (per `primary-source-mirrors.md`)

### 2. PDF structure analysis

Examine PDFs to understand format variations across years:
- Table layouts (county × month matrices? summary tables?)
- What fields are available (fatalities by county, by type, by month?)
- Whether pedestrian/cyclist/driver breakdowns exist
- Format consistency year-to-year

### 3. Parsing pipeline

**Approach**: Python script using `pdfplumber` or `camelot` for table extraction.

```
njsp/historical/
  pdfs/           # Source PDFs
  parse.py        # PDF → structured data
  data/           # Output: one CSV/parquet per year
```

Output schema (match existing NJSP data):
```
year, county, month, fatalities, [pedestrians, cyclists, drivers, passengers]
```

### 4. Integration

- Merge historical data into `njsp/` data pipeline
- Extend `year-type-county.db` (or equivalent) with pre-2008 rows
- County pages' HomicidesComparisonPlot can then show longer series
- FatalitiesPerYearPlot can extend its x-axis back

### 5. Validation

- Cross-reference with FARS (Fatality Analysis Reporting System) data for the same years
- Check that 2008 values match between PDF-parsed and existing web-scraped data (overlap year)
- Flag any discrepancies

## Risks

- PDF formats may vary significantly year-to-year
- Older PDFs may be scanned images (need OCR)
- County definitions may have changed (e.g. Princeton merger was 2013)
- Some years may not have per-county breakdowns
