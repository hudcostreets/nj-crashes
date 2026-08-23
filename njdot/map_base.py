"""Project raw crashes onto the map's column set, with effective lat/lon.

`_build_base` is what every map-facing export starts from: it resolves each
crash's coordinates (interpolated milepost position when available, else the
original geocode, NJ-bbox-guarded), records which source won in `geocode_src`,
drops the ungeocoded, and narrows dtypes.

Extracted from `njdot/cli/export_map_data.py` — the v1 map export
(`by-year/`, `by-year-county/`, `hex-r{N}/`), whose own outputs stopped being
fetched long ago and whose H3 aggregation went away with
`specs/h3-removal.md` Phase 3. This helper was the only part with live
callers: `njdot export_map_v2` and `njdot compute cells raw`.
"""
import numpy as np
import pandas as pd

SEVERITY_ORDER = ["f", "i", "p"]

# Columns we ship to the map (small schema; keep narrow ints where possible).
MAP_COLS = [
    "dt", "cc", "mc", "case",
    "tk", "ti", "pk", "pi", "tv",
    "severity", "road", "cross_street", "route", "mp", "sri",
    "lat", "lon", "geocode_src",
]


def _build_base(df: pd.DataFrame, keep_severities: set[str]) -> pd.DataFrame:
    """Project to map columns, compute effective lat/lon + provenance."""
    if keep_severities:
        df = df[df["severity"].isin(keep_severities)].copy()
    else:
        df = df.copy()

    # Prefer interpolated (ilat/ilon), fall back to original (olat/olon)
    ilat = df["ilat"]
    ilon = df["ilon"]
    olat = df["olat"].where(_in_nj_bbox(df["olat"], df["olon"]))
    olon = df["olon"].where(_in_nj_bbox(df["olat"], df["olon"]))

    lat = ilat.fillna(olat)
    lon = ilon.fillna(olon)

    src = np.full(len(df), "none", dtype=object)
    src[ilat.notna().values] = "interpolated"
    needs_o = ilat.isna().values & olat.notna().values
    src[needs_o] = "original"
    df["lat"] = lat.astype("float32")
    df["lon"] = lon.astype("float32")
    df["geocode_src"] = src

    keep = df[df["lat"].notna() & df["lon"].notna()].copy()

    # Narrow types
    keep["cc"] = keep["cc"].astype("Int8")
    keep["mc"] = keep["mc"].astype("Int16")
    for c in ("tk", "ti", "pk", "pi", "tv"):
        keep[c] = keep[c].fillna(0).astype("int16")
    # Route is often numeric but we store as str for dictionary-encoding
    keep["route"] = keep["route"].astype("string")
    keep["sri"] = keep["sri"].astype("string")
    # Road is the human-readable label ("ROUTE 9", "CALDERON AVENUE", etc.).
    # Cross_street is its perpendicular at the crash location ("CR 630").
    keep["road"] = keep["road"].fillna("").astype("string").str.strip()
    keep["cross_street"] = keep["cross_street"].fillna("").astype("string").str.strip()
    keep["mp"] = keep["mp"].astype("float32")
    keep["severity"] = keep["severity"].astype("string")
    keep["case"] = keep["case"].astype("string")
    keep["geocode_src"] = keep["geocode_src"].astype("string")
    # Date as epoch minutes (int32 fits years 1970..6000ish). Source is
    # datetime64[us] in the parquet — microseconds to minutes divides by 60e6.
    keep["dt"] = (keep["dt"].astype("datetime64[ns]").astype("int64") // 60_000_000_000).astype("int32")
    return keep[MAP_COLS]


def _in_nj_bbox(lat, lon) -> pd.Series:
    """True for coords inside a generous NJ bounding box, excluding 0/NaN."""
    lat_ok = lat.between(38.9, 41.4)
    lon_ok = lon.between(-75.7, -73.9)
    return lat_ok & lon_ok
