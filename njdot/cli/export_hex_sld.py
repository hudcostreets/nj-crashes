"""Build the hex → nearest-MP-name + muni/county sidecar for the crash map.

For each unique H3 cell at r6-r11 that contains a geocoded crash, compute
the cell centroid (h3.cell_to_latlng), find the nearest tenth-mile MP
point in `njdot/data/nj_mp_tenths.parquet` (KD-tree on lon/lat), and the
containing municipality / county via point-in-polygon against
`Municipal_Boundaries_of_NJ.geojson`. Emit a single dedup'd parquet:

    www/public/njdot/map/v2/hex-sld.parquet
        h3 | sld_name | sri | mp | route_subt | mun | county

Used by `<CrashMap>`'s tooltip to surface a human-readable road name
("FR RIVER RD TO NJ 3 EB", "DELAWARE AV") alongside muni context
("Wall (Monmouth)"). The client `useHexSld` walks parents to find the
finest available entry, so r12-r14 hexes inherit their r11 ancestor's
road. Source is `load_crashes_with_aashto()` (decoupled from the
local v2 pyramid, which only goes to r9). ROADMAP item (j).
"""
import json
import sys
from functools import partial

import click
import h3
import pandas as pd
from scipy.spatial import cKDTree

from .base import njdot
from njdot.load import load_crashes_with_aashto

err = partial(print, file=sys.stderr)

DEFAULT_MP_PATH = "njdot/data/nj_mp_tenths.parquet"
DEFAULT_MUNI_PATH = "www/public/Municipal_Boundaries_of_NJ.geojson"
DEFAULT_OUT = "www/public/njdot/map/v2/hex-sld.parquet"
RESOLUTIONS = [6, 7, 8, 9, 10, 11]


def _unique_h3s() -> pd.Series:
    """Compute distinct H3 cell IDs per resolution from geocoded crashes,
    then union across all resolutions. Each crash contributes one cell
    per resolution; the union is the set of cells the client may ever
    look up."""
    # `year` is required by the loader's logging; selected here so we
    # avoid loading the full schema.
    crashes = load_crashes_with_aashto(columns=["year", "olat", "olon"])
    crashes = crashes.dropna(subset=["olat", "olon"]).reset_index(drop=True)
    err(f"  {len(crashes):,} crashes with lat/lon")
    lat = crashes["olat"].to_numpy()
    lon = crashes["olon"].to_numpy()
    all_h3s: list[pd.Series] = []
    for res in RESOLUTIONS:
        cells = pd.Series([h3.latlng_to_cell(la, lo, res) for la, lo in zip(lat, lon)])
        n_unique = cells.nunique()
        err(f"  r{res}: {n_unique:,} unique cells")
        all_h3s.append(cells.drop_duplicates())
    s = pd.concat(all_h3s).drop_duplicates().reset_index(drop=True)
    err(f"Total: {len(s):,} unique cells across r{RESOLUTIONS}")
    return s


def _hex_centroids(h3s: pd.Series) -> pd.DataFrame:
    """Compute (lat, lon) centroid of each H3 cell."""
    lat_lon = h3s.map(h3.cell_to_latlng)
    return pd.DataFrame({
        "h3": h3s.values,
        "lat": [ll[0] for ll in lat_lon],
        "lon": [ll[1] for ll in lat_lon],
    })


def _nearest_mp(centroids: pd.DataFrame, mp: pd.DataFrame) -> pd.DataFrame:
    """For each centroid, find the nearest MP row by Euclidean distance on
    (lon, lat). Approximate but fine at NJ latitudes for the few-hundred-
    foot precision we need. Returns centroids enriched with MP fields."""
    mp = mp.dropna(subset=["lat", "lon"]).reset_index(drop=True)
    tree = cKDTree(mp[["lon", "lat"]].values)
    _, idx = tree.query(centroids[["lon", "lat"]].values, k=1)
    nearest = mp.iloc[idx].reset_index(drop=True)
    out = pd.DataFrame({
        "h3": centroids["h3"].values,
        "sld_name": nearest["SLD_NAME"].values,
        "sri": nearest["SRI"].values,
        "mp": nearest["MP"].values,
        "route_subt": nearest["ROUTE_SUBT"].astype("int8").values,
    })
    return out


def _muni_county(centroids: pd.DataFrame, muni_path: str) -> pd.DataFrame:
    """Point-in-polygon: assign each centroid to its containing
    municipality. Empty strings for ocean/boundary misses. Uses shapely
    `STRtree` for fast bbox prefiltering then exact contains check."""
    from shapely.geometry import Point, shape
    from shapely.strtree import STRtree

    with open(muni_path) as f:
        gj = json.load(f)
    polys, muns, counties = [], [], []
    for feat in gj["features"]:
        props = feat["properties"]
        polys.append(shape(feat["geometry"]))
        muns.append(props.get("MUN_LABEL") or props.get("MUN") or "")
        counties.append((props.get("COUNTY") or "").title())
    tree = STRtree(polys)
    pts = [Point(lon, lat) for lon, lat in zip(centroids["lon"], centroids["lat"])]
    mun_col, county_col = [], []
    for pt in pts:
        cand = tree.query(pt)
        m, c = "", ""
        for i in cand:
            if polys[i].contains(pt):
                m, c = muns[i], counties[i]
                break
        mun_col.append(m)
        county_col.append(c)
    return pd.DataFrame({
        "h3": centroids["h3"].values,
        "mun": mun_col,
        "county": county_col,
    })


@njdot.command("export_hex_sld")
@click.option("--mp-path", default=DEFAULT_MP_PATH, show_default=True)
@click.option("--muni-path", default=DEFAULT_MUNI_PATH, show_default=True)
@click.option("-o", "--output", default=DEFAULT_OUT, show_default=True)
def export_hex_sld(mp_path: str, muni_path: str, output: str):
    err(f"Enumerating unique H3 cells from canonical crashes (r{RESOLUTIONS})")
    h3s = _unique_h3s()

    err(f"Computing H3 centroids ({len(h3s):,} cells)")
    centroids = _hex_centroids(h3s)

    err(f"Loading MP index: {mp_path}")
    mp = pd.read_parquet(mp_path)
    err(f"  {len(mp):,} MP points; {mp[['lat', 'lon']].notna().all(axis=1).sum():,} with lat+lon")

    err(f"Nearest-neighbor lookup ({len(centroids):,} centroids → {len(mp):,} MPs)")
    sld = _nearest_mp(centroids, mp)

    err(f"Loading muni polygons: {muni_path}")
    err(f"Point-in-polygon lookup ({len(centroids):,} centroids)")
    mc = _muni_county(centroids, muni_path)

    enriched = sld.merge(mc, on="h3", how="left")
    n_unmatched = (enriched["mun"] == "").sum()
    err(f"  {len(enriched) - n_unmatched:,} matched, {n_unmatched:,} ocean/boundary misses")

    enriched.to_parquet(output, index=False)
    from os import stat
    size_kb = stat(output).st_size / 1024
    err(f"Wrote {output} ({len(enriched):,} rows, {size_kb:.1f} KB)")
    err(f"\nSample:")
    err(enriched.head(8).to_string())


