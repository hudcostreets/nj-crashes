"""Split `Municipal_Boundaries_of_NJ.geojson` into per-county muni-outline files.

Writes:
    www/public/njdot/map/munis/{cc:02d}.geojson  (one per county; all munis inside)

Each feature has properties `{cc, mc, name, label}` so the client can filter
to a single muni by its NJDOT `(cc, mc)`. NJGIN's `MUN_CODE` column is
`<cc:02d><mc:02d>` which matches NJDOT's codes exactly (verified against
`cc2mc2mn.json` — the only differences are name-format abbreviations like
"Twp" vs "Township").

Geometry is simplified (~30m tolerance) for web delivery. Output size is
~1MB per county.
"""
import json
from pathlib import Path

import click
import geopandas as gpd

from njdot.cli.base import njdot


@njdot.command("gen_muni_outlines")
@click.option("-s", "--src", default="www/public/Municipal_Boundaries_of_NJ.geojson", help="Source muni boundaries geojson")
@click.option("-o", "--out-dir", default="www/public/njdot/map/munis", help="Per-county output dir")
@click.option("-t", "--tolerance", default=0.0003, type=float, help="Simplification tolerance (degrees)")
def gen_muni_outlines(src, out_dir, tolerance):
    """Split NJ muni boundaries into per-county GeoJSON for muni-scope map overlays."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Reading {src}...")
    munis = gpd.read_file(src)
    print(f"  {len(munis)} municipalities")

    # NJGIN's MUN_CODE is a 4-char string "<cc:02d><mc:02d>" per NJDOT's coding.
    munis["cc"] = munis["MUN_CODE"].str[:2].astype(int)
    munis["mc"] = munis["MUN_CODE"].str[2:].astype(int)
    munis["geometry"] = munis.geometry.simplify(tolerance=tolerance, preserve_topology=True)

    for cc, group in munis.groupby("cc"):
        features = []
        for _, row in group.iterrows():
            features.append({
                "type": "Feature",
                "properties": {
                    "cc": int(row["cc"]),
                    "mc": int(row["mc"]),
                    "name": row["NAME"],
                    "label": row["MUN_LABEL"],
                },
                "geometry": json.loads(gpd.GeoSeries([row.geometry]).to_json())["features"][0]["geometry"],
            })
        fc = {"type": "FeatureCollection", "features": features}
        path = out_dir / f"{int(cc):02d}.geojson"
        with path.open("w") as f:
            json.dump(fc, f)
        print(f"  wrote {path} ({path.stat().st_size//1024} KB, {len(features)} munis)")

    return f"Generated muni outlines: {munis['cc'].nunique()} counties, {len(munis)} munis"
