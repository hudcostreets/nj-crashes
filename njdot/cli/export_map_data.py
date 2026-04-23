"""Export NJDOT crashes as sharded parquet for the interactive map.

Layout:
    {outdir}/manifest.json           — bbox + counts per county/year/severity
    {outdir}/by-year/{year}.parquet  — all crashes for year, small row groups
    {outdir}/by-year-county/{year}-{cc:02d}.parquet
    {outdir}/hex-r{N}/{year}.parquet — pre-aggregated hex cells per year

See specs/map-data-backend.md.
"""
import json
from pathlib import Path

import click
import pandas as pd
import numpy as np

from .base import njdot


SEVERITY_ORDER = ["f", "i", "p"]

# Columns we ship to the map (small schema; keep narrow ints where possible).
MAP_COLS = [
    "dt", "cc", "mc", "case",
    "tk", "ti", "pk", "pi", "tv",
    "severity", "route", "mp", "sri",
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


def _emit_shards(df: pd.DataFrame, outdir: Path) -> dict:
    """Write by-year + by-year-county shards. Returns manifest fragment."""
    (outdir / "by-year").mkdir(parents=True, exist_ok=True)
    (outdir / "by-year-county").mkdir(parents=True, exist_ok=True)
    per_year = {}
    per_year_county = {}
    years = sorted(df["dt"].apply(lambda m: pd.Timestamp(m * 60, unit="s", tz="UTC").year).unique().tolist())
    # faster: year via numpy
    df = df.copy()
    df["_year"] = (pd.to_datetime(df["dt"] * 60, unit="s", utc=True)).dt.year
    for y in sorted(df["_year"].unique().tolist()):
        sub = df[df["_year"] == y].drop(columns=["_year"])
        path = outdir / "by-year" / f"{y}.parquet"
        sub.to_parquet(path, row_group_size=20_000, index=False, compression="snappy")
        per_year[int(y)] = len(sub)
        for cc in sorted(sub["cc"].dropna().unique()):
            sub_cc = sub[sub["cc"] == cc]
            if len(sub_cc) == 0:
                continue
            p = outdir / "by-year-county" / f"{y}-{int(cc):02d}.parquet"
            sub_cc.to_parquet(p, row_group_size=5_000, index=False, compression="snappy")
            per_year_county[f"{y}-{int(cc):02d}"] = len(sub_cc)
    return {"per_year": per_year, "per_year_county": per_year_county}


def _emit_hex_aggregates(df: pd.DataFrame, outdir: Path, resolutions=(7, 8)) -> dict:
    """Bin crashes into H3 cells per (year, cc, mc). One parquet per (res, year)."""
    import h3

    manifest = {}
    df = df.copy()
    df["_year"] = pd.to_datetime(df["dt"] * 60, unit="s", utc=True).dt.year.astype("int16")
    # Severity tiers for stacked viz: fatal / ped_inj / other_inj / pdo
    tier = np.where(df["severity"] == "f", "fatal",
            np.where((df["severity"] == "i") & ((df["pi"] > 0) | (df["pk"] > 0)), "ped_inj",
            np.where(df["severity"] == "i", "other_inj", "pdo")))
    df["_tier"] = tier

    for res in resolutions:
        sub_dir = outdir / f"hex-r{res}"
        sub_dir.mkdir(parents=True, exist_ok=True)
        # Compute H3 index per row
        lat_arr = df["lat"].to_numpy()
        lon_arr = df["lon"].to_numpy()
        h3_idx = np.empty(len(df), dtype=object)
        for i, (la, lo) in enumerate(zip(lat_arr, lon_arr)):
            h3_idx[i] = h3.latlng_to_cell(float(la), float(lo), res)
        df[f"_h3_r{res}"] = h3_idx

        # Aggregate
        grouped = (
            df.groupby([f"_h3_r{res}", "_year", "cc", "mc", "_tier"])
            .size()
            .unstack(fill_value=0)
            .reset_index()
            .rename(columns={
                f"_h3_r{res}": "h3",
                "_year": "year",
                "fatal": "n_fatal",
                "ped_inj": "n_ped_inj",
                "other_inj": "n_other_inj",
                "pdo": "n_pdo",
            })
        )
        # Ensure all tier columns exist (some might be absent if filtered)
        for col in ("n_fatal", "n_ped_inj", "n_other_inj", "n_pdo"):
            if col not in grouped.columns:
                grouped[col] = 0
        # Cast counts to int32
        for col in ("n_fatal", "n_ped_inj", "n_other_inj", "n_pdo"):
            grouped[col] = grouped[col].astype("int32")
        grouped["year"] = grouped["year"].astype("int16")
        grouped["cc"] = grouped["cc"].astype("Int8")
        grouped["mc"] = grouped["mc"].astype("Int16")
        grouped["h3"] = grouped["h3"].astype("string")
        grouped = grouped[["h3", "year", "cc", "mc", "n_fatal", "n_ped_inj", "n_other_inj", "n_pdo"]]

        per_year = {}
        for y, sub in grouped.groupby("year"):
            p = sub_dir / f"{int(y)}.parquet"
            sub.to_parquet(p, row_group_size=10_000, index=False, compression="snappy")
            per_year[int(y)] = len(sub)
        manifest[f"r{res}"] = per_year
        df = df.drop(columns=[f"_h3_r{res}"])

    return manifest


@njdot.command("export_map_data")
@click.option("-o", "--outdir", default="www/public/njdot/map", help="Output dir for map data")
@click.option("-s", "--severities", default="i,f", help="Severities for the point-level shards (default: i,f). PDO is excluded by default because including it ~4x's the point dataset.")
@click.option("-H", "--hex-severities", default="i,f,p", help="Severities for the hex aggregates (default: i,f,p). PDO counts are cheap at the aggregate level.")
@click.option("--years", default=None, help="Year range, e.g. 2019:2023 (inclusive, default: all)")
@click.option("--hex-resolutions", default="7,8", help="H3 resolutions for pre-aggregates")
def export_map_data(outdir, severities, hex_severities, years, hex_resolutions):
    """Export crash data as sharded parquet for the interactive map frontend."""
    print(f"Loading crashes.parquet...")
    df = pd.read_parquet("njdot/data/crashes.parquet")
    print(f"  loaded {len(df):,} crashes")

    if years:
        y0, y1 = [int(x) for x in years.split(":")]
        df = df[(df["year"] >= y0) & (df["year"] <= y1)]
        print(f"  filtered to years {y0}-{y1}: {len(df):,}")

    point_sevs = {s.strip() for s in severities.split(",") if s.strip()}
    hex_sevs = {s.strip() for s in hex_severities.split(",") if s.strip()}
    print(f"  point severities: {sorted(point_sevs)}")
    print(f"  hex severities:   {sorted(hex_sevs)}")

    # Build once for the hex agg (widest), then filter down for point shards.
    hex_base = _build_base(df, hex_sevs)
    point_base = hex_base[hex_base["severity"].isin(point_sevs)].copy()
    print(f"  with lat/lon: {len(hex_base):,} total, {len(point_base):,} points")

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)

    dts = pd.to_datetime(hex_base["dt"] * 60, unit="s", utc=True)
    # Per-county + per-muni bboxes for client map fit-bounds. Use 1st-99th
    # percentile to avoid outliers (a few crashes with `olat` values that pass
    # the NJ bbox but are wildly misattributed to a different county).
    def _bbox(sub):
        lat_lo, lat_hi = sub["lat"].quantile([0.01, 0.99])
        lon_lo, lon_hi = sub["lon"].quantile([0.01, 0.99])
        dlat = (lat_hi - lat_lo) * 0.05
        dlon = (lon_hi - lon_lo) * 0.05
        return [
            float(lon_lo - dlon), float(lat_lo - dlat),
            float(lon_hi + dlon), float(lat_hi + dlat),
        ]
    county_bboxes = {}
    muni_bboxes = {}
    for cc, sub in hex_base.groupby("cc"):
        if len(sub) < 3:
            continue
        county_bboxes[int(cc)] = _bbox(sub)
        for mc, msub in sub.groupby("mc"):
            if len(msub) < 3:
                continue
            muni_bboxes[f"{int(cc)}-{int(mc)}"] = _bbox(msub)
    manifest = {
        "schema_version": 1,
        "point_severities": sorted(point_sevs),
        "hex_severities": sorted(hex_sevs),
        "year_range": [int(dts.dt.year.min()), int(dts.dt.year.max())],
        "dt_epoch_minutes_range": [int(hex_base["dt"].min()), int(hex_base["dt"].max())],
        "total_rows": int(len(hex_base)),
        "point_rows": int(len(point_base)),
        "by_geocode_src": hex_base["geocode_src"].value_counts().to_dict(),
        "county_bboxes": county_bboxes,
        "muni_bboxes": muni_bboxes,
    }

    print(f"\nWriting by-year + by-year-county shards to {out}/...")
    shard_manifest = _emit_shards(point_base, out)
    manifest.update(shard_manifest)

    res_list = [int(r) for r in hex_resolutions.split(",") if r]
    print(f"\nComputing h3 aggregates (resolutions {res_list})...")
    hex_manifest = _emit_hex_aggregates(hex_base, out, resolutions=res_list)
    manifest["hex_aggregates"] = hex_manifest

    manifest_path = out / "manifest.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2, default=str)
    print(f"\nWrote manifest to {manifest_path}")
    return f"Export map data ({len(hex_base):,} hex / {len(point_base):,} point crashes, years {manifest['year_range'][0]}-{manifest['year_range'][1]})"
