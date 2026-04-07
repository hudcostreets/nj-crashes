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

**Use the existing D1 API** (`api/src/index.ts`). All 6 databases (crashes, vehicles, occupants, pedestrians, cmymc, njsp-crashes) are already deployed to Cloudflare D1 and served via the Worker at `https://crashes-api.ryan-0dc.workers.dev`.

New endpoint needed:
- `GET /njdot/crash?year=&cc=&mc=&case=` — returns crash + joined vehicles/occupants/pedestrians
- Or separate fetches using existing `/njdot/vehicles?crash_ids=` etc. endpoints (already exist)

## Linking

### From Maps
- Click a crash marker on any map → link to crash detail page
- Popup shows summary, "View details →" link

### From Tables
- Municipality pages will have crash tables → each row links to detail page

### From Search
- Future: search by case number, location, date range

## Implementation Order
1. Add `/njdot/crash` API endpoint (or use existing endpoints)
2. Add route + page component for `/crash/:year/:cc/:mc/:case`
3. Build crash detail page with basic crash info
4. Add vehicle/occupant/pedestrian sections (data already available via API)
5. Wire up table row links → detail page
6. Add NJSP cross-reference for fatal crashes
