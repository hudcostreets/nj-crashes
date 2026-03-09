# Individual Crash Detail Pages

Add pages for individual crashes, linked from maps and tables.

## URL Structure

Two ID systems exist:
- **NJDOT PK**: `(year, cc, mc, case)` — e.g. `2023/03/38/2023-00002089`
- **NJSP case number**: only for fatal crashes tracked by State Police

### Proposed Routes
- `/crash/:year/:cc/:mc/:case` — NJDOT crash by full PK
- `/crash/njsp/:id` — NJSP fatal crash by case number (redirects or shows NJSP-specific view)

### URL Encoding
- `case` field may contain slashes or special chars — URL-encode as needed
- Consider a shorter encoding: base64 or hash of the PK for shorter URLs

## Page Content

### Crash Summary
- Date, time, location (address + lat/lng)
- County, municipality (linked to `/c/:county/:city`)
- Severity (fatal/injury/PDO)
- Weather, road conditions, light conditions
- Map pin showing exact location

### Vehicles
- List of vehicles involved (from `vehicles.parquet`)
- Vehicle type, make, model, year
- Travel direction, pre-crash action

### People
- Drivers (from `drivers.parquet`) — age, sex, injury severity, contributing factors
- Occupants (from `occupants.parquet`) — position, restraint use, injury severity
- Pedestrians (from `pedestrians.parquet`) — age, sex, action, injury severity

### Diagram / Map
- Small map centered on crash location
- Show nearby crashes (same intersection?) as context

## Data Access

### Option A: DuckDB-WASM queries
- Query `crashes.db`, `vehicles.db`, etc. on the client
- Flexible, no new data files needed
- But: multiple large DB downloads for a single crash page

### Option B: Pre-computed JSON per crash
- Too many files (6.6M+ crashes × 5 entity types)
- Not feasible

### Option C: API endpoint
- Lightweight server or serverless function queries a hosted DB
- Best for individual crash lookups
- Could use Cloudflare Workers + D1 or similar

### Recommendation
- Start with DuckDB-WASM (already have the infrastructure from `/duckdb` page stub)
- The DBs are already served; just need targeted queries
- Cache aggressively since crash data is immutable

## Linking

### From Maps
- Click a crash marker on any map → link to crash detail page
- Popup shows summary, "View details →" link

### From Tables
- Municipality pages will have crash tables → each row links to detail page

### From Search
- Future: search by case number, location, date range

## Implementation Order
1. Set up DuckDB-WASM query infrastructure (may already be partially done in `/duckdb` stub)
2. Build crash detail page with basic crash info
3. Add vehicle/driver/occupant/pedestrian sections
4. Wire up map marker click → detail page links
5. Add NJSP cross-reference for fatal crashes
