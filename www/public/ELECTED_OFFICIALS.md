# Elected Officials Data Sources

This document catalogs data sources for NJ elected officials at all levels, with the goal of creating a comprehensive historical database (2001-present) to join with crash data.

## Goal

Build a database of all NJ elected officials with terms covering 2001-2025, including:
- **Federal**: U.S. House Representatives, U.S. Senators
- **State**: State Assembly, State Senate
- **County**: County Executives, County Commissioners/Freeholders
- **Municipal**: Mayors, Council Members (where available)

## Data Sources

### State Legislative Districts

#### Current Districts (2023-2031)
- **NJDOT GIS**: https://dot.nj.gov/transportation/refdata/gis/map.shtm
  - Shapefile: `Legislative_Districts_of_NJ.zip` (tracked in DVC)
  - PDF Map: `Legislative2331.pdf` (tracked in DVC)
- **Coverage**: 40 Legislative Districts (each elects 1 Senator + 2 Assembly members)
- **Redistricting**: 2023-2031 cycle

#### Historical Districts
- **221st Legislature PDF**: https://dot.nj.gov/transportation/refdata/gis/maps/legislative.pdf
  - Includes member names and positions
  - May be useful for historical reference

### State Legislators

#### NJ Legislature Official Site
- **Assembly**: https://www.njleg.state.nj.us/legislative-roster/assemblymen
- **Senate**: https://www.njleg.state.nj.us/legislative-roster/senators
- **Coverage**: Current legislators with contact info, committee assignments
- **Historical**: Check if archived versions available via Wayback Machine

#### Ballotpedia
- **NJ State Assembly**: https://ballotpedia.org/New_Jersey_General_Assembly
- **NJ State Senate**: https://ballotpedia.org/New_Jersey_State_Senate
- **Coverage**: Historical election results, terms, district assignments
- **Format**: Web scraping required

#### OpenStates
- **API**: https://openstates.org/nj/
- **Coverage**: Legislators with terms, districts, party affiliation
- **Historical**: Data back to 2009
- **Format**: JSON API (may require registration)

### Congressional Districts

#### Current Districts
- **NJDOT Shapefile**: `Congressional_Districts_of_NJ.zip` (tracked in DVC)
- **NJGIN GeoJSON**: `Congressional_Districts_of_NJ_Hosted_3424_*.geojson` (tracked in DVC)
- **Coverage**: 12 U.S. House districts

#### U.S. House Representatives

##### Official Sources
- **U.S. House History**: https://history.house.gov/People/Search
  - Filter by State: New Jersey
  - Historical data back to 1789
  - Includes terms, party, district

##### Ballotpedia
- **NJ Congressional Delegation**: https://ballotpedia.org/United_States_congressional_delegations_from_New_Jersey
- **Coverage**: Historical and current representatives
- **Format**: Web tables

##### GovTrack
- **API**: https://www.govtrack.us/api/v2/role?current=false&state=NJ&role_type=representative
- **Coverage**: All terms with start/end dates, district, party
- **Format**: JSON API

#### U.S. Senators

##### Official Sources
- **U.S. Senate Historical Office**: https://www.senate.gov/senators/
- **NJ Senators**: https://www.senate.gov/states/NJ/intro.htm
- **Coverage**: Complete historical record

##### Ballotpedia
- **NJ Senate Elections**: https://ballotpedia.org/United_States_Senate_elections_in_New_Jersey
- **Coverage**: Election results, terms

### County Government

#### County Executives and Boards

##### NJ Association of Counties
- **Website**: https://www.njac.org/
- **Coverage**: Current county officials, contact info
- **Format**: May require scraping or manual compilation

##### County Government Websites
Each of NJ's 21 counties has official websites:
- **Atlantic**: https://www.atlantic-county.org/
- **Bergen**: https://www.co.bergen.nj.us/
- **Burlington**: https://www.co.burlington.nj.us/
- **Camden**: https://www.camdencounty.com/
- **Cape May**: https://www.capemaycountygov.net/
- **Cumberland**: https://www.co.cumberland.nj.us/
- **Essex**: https://www.essexcountynj.org/
- **Gloucester**: https://www.co.gloucester.nj.us/
- **Hudson**: https://www.hudsoncountynj.org/
- **Hunterdon**: https://www.co.hunterdon.nj.us/
- **Mercer**: https://www.mercercounty.org/
- **Middlesex**: https://www.middlesexcountynj.gov/
- **Monmouth**: https://www.monmouthcountynj.gov/
- **Morris**: https://www.morriscountynj.gov/
- **Ocean**: https://www.oceancountygov.com/
- **Passaic**: https://www.passaiccountynj.org/
- **Salem**: https://www.salemcountynj.gov/
- **Somerset**: https://www.co.somerset.nj.us/
- **Sussex**: https://www.sussex.nj.us/
- **Union**: https://ucnj.org/
- **Warren**: https://www.warrencountynj.org/

**Note**: Governance structure varies:
- Some counties have elected executives (Essex, Hudson, etc.)
- Others have freeholder/commissioner boards
- May need to compile historical data manually or via Wayback Machine

#### Ballotpedia County Pages
- **Format**: https://ballotpedia.org/[County_Name]_County,_New_Jersey
- **Example**: https://ballotpedia.org/Essex_County,_New_Jersey
- **Coverage**: Election results, current officials

### Municipal Government

#### Mayors and Council Members

##### NJ League of Municipalities
- **Website**: https://www.njlm.org/
- **Coverage**: May have directories or contact lists
- **Challenge**: 564 municipalities - very large dataset

##### Municipal Websites
- Each municipality has its own website
- Historical data may be sparse or require Wayback Machine
- **Approach**: May need to prioritize larger municipalities or those with high crash counts

##### Ballotpedia Municipal Pages
- **Format**: https://ballotpedia.org/[Municipality_Name],_New_Jersey
- **Example**: https://ballotpedia.org/Newark,_New_Jersey
- **Coverage**: Varies by municipality size

## Data Compilation Strategy

### Phase 1: Federal and State (Higher Priority)
1. **U.S. Senators**: 2 seats, complete records available
2. **U.S. House**: 12 districts, good API/data sources
3. **State Senate**: 40 districts, 1 senator each
4. **State Assembly**: 40 districts, 2 members each (80 total)

### Phase 2: County Government
1. Compile county executive/board structure for each county
2. Focus on counties with highest crash counts first
3. Use combination of:
   - Current official sites
   - Ballotpedia
   - Wayback Machine for historical data

### Phase 3: Municipal Government (Optional/Selective)
1. Start with largest municipalities (e.g., Newark, Jersey City, Paterson)
2. Consider limiting to municipalities with >1000 crashes in dataset
3. Or limit to mayors only (skip council members due to scale)

## Data Schema

Proposed database structure:

```sql
CREATE TABLE elected_officials (
    id INTEGER PRIMARY KEY,
    office_type TEXT, -- 'us_senate', 'us_house', 'state_senate', 'state_assembly', 'county_exec', 'county_commissioner', 'mayor', 'council'
    jurisdiction TEXT, -- 'NJ', district number, county name, or municipality name
    name TEXT,
    party TEXT,
    term_start DATE,
    term_end DATE,
    district INTEGER, -- for legislative districts
    county_code INTEGER, -- for county/municipal officials
    municipality_code INTEGER -- for municipal officials
);

-- Spatial join table
CREATE TABLE crash_officials (
    crash_id TEXT,
    official_id INTEGER,
    FOREIGN KEY (official_id) REFERENCES elected_officials(id)
);
```

## Next Steps

1. **Federal Data**: Start with GovTrack API for U.S. House and Senate
2. **State Data**: Use Ballotpedia + OpenStates for NJ Legislature
3. **Script Development**: Create data fetching/scraping scripts
4. **Historical Validation**: Cross-reference multiple sources
5. **Database Integration**: Design schema and import pipeline

## Notes

- **Redistricting**: Be aware of district boundary changes:
  - Congressional: After each census (2001, 2011, 2021)
  - State Legislative: 2001, 2011, 2023
- **Term Lengths**:
  - U.S. Senate: 6 years
  - U.S. House: 2 years
  - State Senate: 4 years (except 2 years after redistricting)
  - State Assembly: 2 years
  - County/Municipal: Varies by jurisdiction
- **Data Quality**: Historical data may be incomplete, especially for smaller municipalities

## References

- NJ Legislature: https://www.njleg.state.nj.us/
- NJ Division of Elections: https://nj.gov/state/elections/
- Ballotpedia NJ Portal: https://ballotpedia.org/New_Jersey
- OpenStates NJ: https://openstates.org/nj/
- GovTrack: https://www.govtrack.us/
