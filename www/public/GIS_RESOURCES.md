# GIS and Political Boundary Resources

This document catalogs geographic and political boundary datasets used in the crashes project.

## Municipality Boundaries

### NJGIN Municipal Boundaries
- **Source**: https://njogis-newjersey.opendata.arcgis.com/datasets/newjersey::municipal-boundaries-of-nj-hosted-3857/explore
- **Previous URL** (broken): https://njogis-newjersey.opendata.arcgis.com/datasets/3d5d1db8a1b34b418c331f4ce1fd0fef/explore
- **File**: `Municipal_Boundaries_of_NJ.geojson` (tracked in DVC)
- **Description**: Official NJ municipality boundaries from NJ Office of GIS
- **Usage**: Primary source for municipality geocoding in crash data pipeline
- **CRS**: EPSG:3857 (Web Mercator)

## Legislative Districts

### State Legislative Districts (2023-2031)
- **Source**: https://dot.nj.gov/transportation/refdata/gis/map.shtm
- **Files**:
  - PDF Map: `Legislative2331.pdf` (tracked in DVC)
    - URL: https://dot.nj.gov/transportation/refdata/gis/maps/Legislative2331.pdf
  - Shapefile: `Legislative_Districts_of_NJ.zip` (tracked in DVC)
    - URL: https://dot.nj.gov/transportation/refdata/gis/maps/zipshape/Legislative_Districts_of_NJ.zip
  - Older PDF: `legislative.pdf` ("Legislative Districts 221st")
    - URL: https://dot.nj.gov/transportation/refdata/gis/maps/legislative.pdf
    - Note: Includes member names and different number positions; likely superseded by shapefile
- **Description**: NJ State Assembly and Senate district boundaries
- **Redistricting Period**: 2023-2031 (per Legislative2331.pdf)

### Congressional Districts
- **Source**: NJDOT GIS Data Portal
- **Files**:
  - NJDOT Shapefile: `Congressional_Districts_of_NJ.zip` (tracked in DVC)
    - URL: https://dot.nj.gov/transportation/refdata/gis/maps/zipshape/Congressional_Districts_of_NJ.zip
  - NJGIN GeoJSON: `Congressional_Districts_of_NJ_Hosted_3424_8961029961981098557.geojson` (tracked in DVC)
    - URL: https://njogis-newjersey.opendata.arcgis.com/datasets/newjersey::congressional-districts-of-nj-hosted-3424/explore?showTable=true
- **Description**: U.S. Congressional district boundaries for New Jersey

## County Boundaries

### NJGIN County Boundaries
- **Source**: NJGIN ArcGIS Open Data Portal
- **URL**: https://njogis-newjersey.opendata.arcgis.com/
- **Description**: County-level administrative boundaries
- **Note**: Also available through NJDOT GIS portal

## Usage in Crash Data Pipeline

1. **Municipality Geocoding**:
   - `Municipal_Boundaries_of_NJ.geojson` is the authoritative source
   - Used to map crash lat/lon coordinates to (county_code, municipality_code) pairs
   - See `nj_crashes/muni_codes.py` for implementation

2. **Political District Analysis** (planned):
   - Legislative and congressional boundaries for joining with elected officials data
   - Enable analysis of crash trends by political district and term

## Data Management

All GIS files are tracked with DVC:
```bash
# Pull all GIS data
dvc pull www/public/*.{geojson,pdf,zip}.dvc

# Update specific dataset
dvc pull www/public/Municipal_Boundaries_of_NJ.geojson.dvc
```

## Notes

- NJGIN datasets tend to be more frequently updated than NJDOT versions
- Check both sources for latest versions
- NJDOT URLs: https://dot.nj.gov/transportation/refdata/gis/map.shtm
- NJGIN Portal: https://njogis-newjersey.opendata.arcgis.com/
