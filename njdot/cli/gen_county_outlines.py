#!/usr/bin/env python
"""Dissolve Municipal_Boundaries_of_NJ.geojson into per-county GeoJSON polygons.

Writes:
    www/public/njdot/map/counties/{cc:02d}.geojson
    www/public/njdot/map/counties.geojson  (statewide: all counties, low-res)
"""
import json
import sys
from pathlib import Path

import geopandas as gpd

sys.path.insert(0, ".")


# NJ county name → cc code (matches `njsp/data/counties.parquet` mapping)
COUNTY_CC = {
    "ATLANTIC": 1, "BERGEN": 2, "BURLINGTON": 3, "CAMDEN": 4, "CAPE MAY": 5,
    "CUMBERLAND": 6, "ESSEX": 7, "GLOUCESTER": 8, "HUDSON": 9, "HUNTERDON": 10,
    "MERCER": 11, "MIDDLESEX": 12, "MONMOUTH": 13, "MORRIS": 14, "OCEAN": 15,
    "PASSAIC": 16, "SALEM": 17, "SOMERSET": 18, "SUSSEX": 19, "UNION": 20,
    "WARREN": 21,
}


def main():
    src = "www/public/Municipal_Boundaries_of_NJ.geojson"
    out_dir = Path("www/public/njdot/map/counties")
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Reading {src}...")
    munis = gpd.read_file(src)
    print(f"  {len(munis)} municipalities")
    munis["COUNTY"] = munis["COUNTY"].str.upper()
    print("Dissolving by county...")
    counties = munis.dissolve(by="COUNTY").reset_index()
    counties["cc"] = counties["COUNTY"].map(COUNTY_CC)
    missing = counties[counties["cc"].isna()]
    if len(missing):
        print(f"  WARN: unmapped counties: {missing['COUNTY'].tolist()}")
    # Simplify for web delivery (~30m tolerance)
    counties["geometry"] = counties.geometry.simplify(tolerance=0.0003, preserve_topology=True)

    for _, row in counties.iterrows():
        cc = int(row["cc"]) if not gpd.pd.isna(row["cc"]) else None
        if cc is None:
            continue
        feat = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"cc": cc, "name": row["COUNTY"].title()},
                "geometry": json.loads(gpd.GeoSeries([row.geometry]).to_json())["features"][0]["geometry"],
            }],
        }
        path = out_dir / f"{cc:02d}.geojson"
        with path.open("w") as f:
            json.dump(feat, f)
        print(f"  wrote {path} ({path.stat().st_size//1024} KB)")

    # Also write the statewide combined
    combined = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"cc": int(r["cc"]) if not gpd.pd.isna(r["cc"]) else None, "name": r["COUNTY"].title()},
                "geometry": json.loads(gpd.GeoSeries([r.geometry]).to_json())["features"][0]["geometry"],
            }
            for _, r in counties.iterrows()
        ],
    }
    combined_path = out_dir.parent / "counties.geojson"
    with combined_path.open("w") as f:
        json.dump(combined, f)
    print(f"\nWrote combined {combined_path} ({combined_path.stat().st_size//1024} KB)")


if __name__ == "__main__":
    main()
