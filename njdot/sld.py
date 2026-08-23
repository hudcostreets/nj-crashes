"""Per-cell road / municipality labels: nearest milepost + point-in-polygon.

Both lookups take a `cell | lat | lon` frame and are grid-agnostic — they
only ever read the centroid columns and carry `cell` through — which is why
they survived `specs/h3-removal.md` (they lived in the deleted
`njdot/cli/export_hex_sld.py`). `njdot compute cells sld` is the one caller;
it feeds S2 cell tokens as `cell` and writes `data/cells/s2-sld.parquet`,
whose columns get baked into every pyramid row and D1 rollup row so the
worker never joins labels at request time.
"""
import json
import sys
from functools import partial

import pandas as pd
from scipy.spatial import cKDTree

err = partial(print, file=sys.stderr)

DEFAULT_MP_PATH = "njdot/data/nj_mp_tenths.parquet"
DEFAULT_MUNI_PATH = "www/public/Municipal_Boundaries_of_NJ.geojson"

"""Distance threshold (in deg, Euclidean on lon/lat) for considering a
2nd-nearest MP a "cross-street". ~80m at NJ latitudes — generous enough
to catch a corner cell's adjacent cross-road but tight enough to skip
distant unrelated roads for mid-block cells. Cells with no qualifying
neighbor get null cross_sld_name (left blank in the tooltip)."""
CROSS_DIST_THRESHOLD = 0.001


def nearest_mp(centroids: pd.DataFrame, mp: pd.DataFrame) -> pd.DataFrame:
    """For each centroid, find the nearest MP row by Euclidean distance on
    (lon, lat). Approximate but fine at NJ latitudes for the few-hundred-
    foot precision we need.

    Also find the nearest MP on a *different* SRI within
    `CROSS_DIST_THRESHOLD` — that's the cell's cross-street, used in the
    tooltip as "PRIMARY @ CROSS". Null when no other-SRI MP exists
    within threshold (typical for mid-block cells).

    Returns centroids enriched with primary + cross MP fields."""
    mp = mp.dropna(subset=["lat", "lon"]).reset_index(drop=True)
    pts = mp[["lon", "lat"]].values
    sris = mp["SRI"].values
    tree = cKDTree(pts)
    _, idx = tree.query(centroids[["lon", "lat"]].values, k=1)
    nearest = mp.iloc[idx].reset_index(drop=True)
    # Find cross-street by querying k≥20 neighbors and picking the first
    # with a different SRI inside the threshold. k=20 covers the dense
    # urban case where each road has many MP rows; we exit at the first
    # qualifying neighbor.
    K = 20
    dists, idxs = tree.query(centroids[["lon", "lat"]].values, k=K)
    primary_sri_arr = sris[idx]
    cross_idx = pd.Series([-1] * len(centroids), dtype="int64")
    for i in range(len(centroids)):
        for j in range(K):
            d = dists[i, j]
            if d > CROSS_DIST_THRESHOLD:
                break
            cand_idx = idxs[i, j]
            if sris[cand_idx] != primary_sri_arr[i]:
                cross_idx.iloc[i] = cand_idx
                break
    has_cross = cross_idx >= 0
    cross_idx_safe = cross_idx.where(has_cross, 0).astype("int64")
    cross = mp.iloc[cross_idx_safe.values].reset_index(drop=True)
    n_with_cross = int(has_cross.sum())
    err(f"  {n_with_cross:,} cells with cross-street (within {CROSS_DIST_THRESHOLD}° ≈ 80m)")
    return pd.DataFrame({
        "cell": centroids["cell"].values,
        "sld_name": nearest["SLD_NAME"].values,
        "sri": nearest["SRI"].values,
        "mp": nearest["MP"].values,
        "route_subt": nearest["ROUTE_SUBT"].astype("int8").values,
        "cross_sld_name": cross["SLD_NAME"].where(has_cross.values, None).values,
        "cross_sri": cross["SRI"].where(has_cross.values, None).values,
        "cross_mp": cross["MP"].where(has_cross.values, pd.NA).values,
    })


def muni_county(centroids: pd.DataFrame, muni_path: str = DEFAULT_MUNI_PATH) -> pd.DataFrame:
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
        "cell": centroids["cell"].values,
        "mun": mun_col,
        "county": county_col,
    })
