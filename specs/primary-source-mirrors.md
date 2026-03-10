# Primary source mirrors and data browser

## Context

The site references primary-source data from NJSP and NJDOT but doesn't host copies. If upstream URLs break (they have before), the data trail is lost. Additionally, the raw parquet files are useful for researchers but not browsable.

## Goals

1. **Mirror PDFs**: NJSP fatal crash PDFs, NJDOT documentation
2. **Mirror raw data**: NJDOT `.txt` / `.zip` files (the raw crash data downloads)
3. **Parquet table browser**: interactive, pageable viewer for `.parquet` files

## Plan

### 1. PDF mirrors

Host copies of:
- NJSP fatal crash statistics page (already have `njsp/Fatal Crash Statistics….html` locally)
- NJDOT raw data page
- Any methodology/codebook PDFs from NJDOT

Serve from `www/public/mirrors/` or a separate S3 path. Add "Archived copy" links alongside primary-source links throughout the site.

### 2. Raw data mirrors

The raw NJDOT `.txt` files (per year, per type) are already processed into parquet. Host the originals:
- `www/public/mirrors/njdot/{year}/NewJersey{year}{Type}.txt.gz` (gzipped originals)
- Add download links on the site, e.g. "Download raw data (2023, 1.2 MB)"

### 3. Parquet table browser

Interactive viewer for parquet files, using DuckDB-WASM to query directly in the browser.

**UI**:
- Select a parquet file (crashes, vehicles, drivers, occupants, pedestrians)
- Paginated table view with column sorting
- SQL query bar for custom queries (optional, power-user feature)
- Column type indicators and basic stats (min/max/null count)

**Implementation options**:
- DuckDB-WASM is already a dependency (via `DuckDbContext`)
- Use `useParquet` hook pattern (already exists for CrashPlot) for loading
- Could reuse `RowsTable` component for rendering

**Route**: `/data/browser` or `/data/{table}` (e.g. `/data/crashes`)

### 4. Data provenance page

A `/data` route listing:
- All available datasets with descriptions, row counts, date ranges
- Links to primary sources and local mirrors
- Download links for parquet files
- DVX provenance info (which command generated each file, dependency hashes)

## Considerations

- **Storage**: Raw NJDOT data is ~500MB uncompressed across all years. Gzipped should be ~50-100MB. S3 hosting is cheap.
- **Freshness**: Mirror script should run as part of the data update pipeline
- **Legal**: NJDOT and NJSP data is public record; mirroring is fine
