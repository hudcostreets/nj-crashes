"""Export NJDOT crashes as H3 r5-sharded parquet for the interactive map (v2).

Layout under {outdir} (typically www/public/njdot/map/v2):

    manifest.v2.json
    points/{shardCell}.parquet         # severity in {f,i}, all years
    hex-r6.parquet                     # whole-state, single file
    hex-r{N}/{shardCell}.parquet       # N in {7,8,9}, sharded by r5 parent

`shardCell` is an H3 r5 cell (NJ has ~150 non-empty r5 cells). The shard
filename is the data's own r5 parent — use it to fetch only the shards
that intersect a viewport.

See specs/map-h3-shard-rearchitecture.md.
"""
import json
from pathlib import Path
from time import time

import click
import h3
import numpy as np
import pandas as pd

from njdot.load import load_crashes_with_aashto

from .base import njdot
from .export_map_data import _build_base


SHARD_RES = 5
HEX_RESOLUTIONS = (6, 7, 8, 9)

POINT_COLS_OUT = [
    "dt", "year", "cc", "mc", "case",
    "tk", "ti", "pk", "pi", "tv",
    "severity", "road", "cross_street", "route", "mp", "sri",
    "lat", "lon", "geocode_src",
    "h3_r5",
]

HEX_COLS_OUT = [
    "h3", "year", "cc", "mc",
    "n_fatal", "n_ped_inj", "n_other_inj", "n_pdo",
    "top_route",
]


def _h3_column(lat: np.ndarray, lon: np.ndarray, res: int) -> np.ndarray:
    """Compute H3 cell strings for each (lat, lon) at the given resolution."""
    out = np.empty(len(lat), dtype=object)
    for i, (la, lo) in enumerate(zip(lat, lon)):
        out[i] = h3.latlng_to_cell(float(la), float(lo), res)
    return out


def _add_h3_cols(df: pd.DataFrame, resolutions) -> pd.DataFrame:
    lat = df["lat"].to_numpy()
    lon = df["lon"].to_numpy()
    for res in resolutions:
        t0 = time()
        cells = _h3_column(lat, lon, res)
        df[f"h3_r{res}"] = pd.array(cells, dtype="string")
        print(f"  h3_r{res}: {time() - t0:.1f}s, {len(np.unique(cells)):,} unique cells")
    return df


def _emit_points(df: pd.DataFrame, outdir: Path, point_sevs: set[str]) -> dict:
    pts_dir = outdir / "points"
    pts_dir.mkdir(parents=True, exist_ok=True)
    pts = df[df["severity"].isin(point_sevs)].copy()
    print(f"\nEmitting points/ ({len(pts):,} rows, {pts['h3_r5'].nunique()} shards)...")
    pts = pts.sort_values(["h3_r5", "year", "h3_r9"], kind="mergesort")
    counts: dict[str, int] = {}
    for cell, sub in pts.groupby("h3_r5", sort=False):
        out = sub[POINT_COLS_OUT]
        path = pts_dir / f"{cell}.parquet"
        out.to_parquet(path, row_group_size=5_000, index=False, compression="snappy")
        counts[str(cell)] = len(out)
    print(f"  wrote {len(counts)} shards, total {sum(counts.values()):,} rows")
    return counts


def _hex_aggregate(df: pd.DataFrame, res: int) -> pd.DataFrame:
    """Group by (h3_r{res}, year, cc, mc) → severity-tier counts + top_route mode."""
    h3_col = f"h3_r{res}"
    tier = np.where(
        df["severity"] == "f", "fatal",
        np.where((df["severity"] == "i") & ((df["pi"] > 0) | (df["pk"] > 0)), "ped_inj",
        np.where(df["severity"] == "i", "other_inj", "pdo")),
    )
    base = df.assign(_tier=tier)
    grouped = (
        base.groupby([h3_col, "year", "cc", "mc", "_tier"])
        .size()
        .unstack(fill_value=0)
        .reset_index()
        .rename(columns={
            h3_col: "h3",
            "fatal": "n_fatal",
            "ped_inj": "n_ped_inj",
            "other_inj": "n_other_inj",
            "pdo": "n_pdo",
        })
    )
    for col in ("n_fatal", "n_ped_inj", "n_other_inj", "n_pdo"):
        if col not in grouped.columns:
            grouped[col] = 0

    road = df["road"].fillna("").astype("string").str.strip()
    rnum = df["route"].fillna("").astype("string").str.strip()
    road_eff = road.where(
        road != "",
        rnum.where(rnum != "", "").map(lambda r: f"Route {r}" if r else ""),
    )
    nb = df.assign(_road=road_eff)
    nb = nb[nb["_road"] != ""]
    if len(nb):
        top = (
            nb.groupby([h3_col, "year", "cc", "mc"])["_road"]
            .agg(lambda s: s.mode().iloc[0] if len(s.mode()) else "")
            .reset_index()
            .rename(columns={h3_col: "h3", "_road": "top_route"})
        )
        grouped = grouped.merge(top, on=["h3", "year", "cc", "mc"], how="left")
        grouped["top_route"] = grouped["top_route"].fillna("").astype("string")
    else:
        grouped["top_route"] = pd.Series([""] * len(grouped), dtype="string")

    for col in ("n_fatal", "n_ped_inj", "n_other_inj", "n_pdo"):
        grouped[col] = grouped[col].astype("int32")
    grouped["year"] = grouped["year"].astype("int16")
    grouped["cc"] = grouped["cc"].astype("Int8")
    grouped["mc"] = grouped["mc"].astype("Int16")
    grouped["h3"] = grouped["h3"].astype("string")
    return grouped[HEX_COLS_OUT].sort_values(["year", "h3"], kind="mergesort").reset_index(drop=True)


def _emit_hex(df: pd.DataFrame, outdir: Path) -> dict:
    """Emit hex-r{N}.parquet single-file (for all N in HEX_RESOLUTIONS) +
    hex-r{N}/{shardCell}.parquet sharded (for N > SHARD_RES + 1).

    The single-files are the picker's fallback when the visible viewport
    intersects too many shards to make per-shard fetches efficient (e.g.
    statewide views). Picker uses the *finest* single-file resolution that
    makes sense at the current zoom — typically r7 at z6-7, r8 at z8-9, r9
    at zoom-in, etc. — so the rendered map keeps a hi-fi look without
    leaking the underlying hex grid.
    """
    counts: dict[str, object] = {}
    for res in HEX_RESOLUTIONS:
        t0 = time()
        agg = _hex_aggregate(df, res)

        # Single-file (always): used by the picker as a one-shot fallback
        # at low/wide-viewport zoom levels.
        single_path = outdir / f"hex-r{res}.parquet"
        agg.to_parquet(single_path, row_group_size=10_000, index=False, compression="snappy")
        single_size = single_path.stat().st_size

        if res <= SHARD_RES + 1:
            counts[f"r{res}"] = len(agg)
            print(f"  hex-r{res}.parquet: {len(agg):,} rows, {single_size / 1024:.0f} KB ({time() - t0:.1f}s)")
        else:
            sub_dir = outdir / f"hex-r{res}"
            sub_dir.mkdir(parents=True, exist_ok=True)
            parents = agg["h3"].apply(lambda c: h3.cell_to_parent(c, SHARD_RES)).astype("string")
            agg_sharded = agg.assign(_parent=parents)
            shard_counts: dict[str, int] = {}
            for cell, sub in agg_sharded.groupby("_parent", sort=False):
                out = sub.drop(columns=["_parent"])
                path = sub_dir / f"{cell}.parquet"
                out.to_parquet(path, row_group_size=10_000, index=False, compression="snappy")
                shard_counts[str(cell)] = len(out)
            counts[f"r{res}"] = shard_counts
            print(f"  hex-r{res}.parquet: {len(agg):,} rows, {single_size / 1024:.0f} KB single-file"
                  f" + {len(shard_counts)} shards ({time() - t0:.1f}s)")
    return counts


def _shard_bboxes(cells) -> dict[str, list[float]]:
    """r5 cell → [w, s, e, n] from cell boundary (lat,lng → lng,lat reordered)."""
    out: dict[str, list[float]] = {}
    for c in cells:
        boundary = h3.cell_to_boundary(c)
        lats = [p[0] for p in boundary]
        lons = [p[1] for p in boundary]
        out[str(c)] = [min(lons), min(lats), max(lons), max(lats)]
    return out


@njdot.command("export_map_v2")
@click.option("-o", "--outdir", default="www/public/njdot/map/v2", help="Output dir")
@click.option("-s", "--severities", default="i,f,p", help="Severities for raw point shards (default: all). Client filters by severity at fetch-time; this just controls which rows are written to disk.")
@click.option("-H", "--hex-severities", default="i,f,p", help="Severities for hex prebins")
@click.option("--years", default=None, help="Year range, e.g. 2019:2023 (inclusive, default: all)")
def export_map_v2(outdir, severities, hex_severities, years):
    """Export H3 r5-sharded crash data for the interactive map (v2 layout)."""
    # Column-filtered read avoids a pyarrow "Unknown error: Wrapping" exception
    # when the full per-table schema tries to round-trip through pandas.
    MAP_INPUT_COLS = [
        "year", "dt", "cc", "mc", "case", "severity",
        "tk", "ti", "pk", "pi", "tv",
        "olat", "olon", "ilat", "ilon",
        "road", "cross_street", "route", "sri", "mp",
    ]
    df = load_crashes_with_aashto(columns=MAP_INPUT_COLS)

    if years:
        y0, y1 = [int(x) for x in years.split(":")]
        df = df[(df["year"] >= y0) & (df["year"] <= y1)]
        print(f"  filtered to years {y0}-{y1}: {len(df):,}")

    point_sevs = {s.strip() for s in severities.split(",") if s.strip()}
    hex_sevs = {s.strip() for s in hex_severities.split(",") if s.strip()}
    print(f"  point severities: {sorted(point_sevs)}")
    print(f"  hex severities:   {sorted(hex_sevs)}")

    base = _build_base(df, hex_sevs)
    print(f"  with lat/lon: {len(base):,}")

    base["year"] = (
        pd.to_datetime(base["dt"] * 60, unit="s", utc=True).dt.year.astype("int16")
    )

    print("\nComputing H3 cells per resolution...")
    base = _add_h3_cols(base, (SHARD_RES,) + HEX_RESOLUTIONS)

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)

    point_counts = _emit_points(base, out, point_sevs)

    print("\nComputing hex aggregates...")
    hex_counts = _emit_hex(base, out)

    shard_cells = sorted(point_counts.keys())
    bboxes = _shard_bboxes(shard_cells)

    shards = {
        "points": shard_cells,
        "hex_r7": sorted(hex_counts["r7"].keys()),
        "hex_r8": sorted(hex_counts["r8"].keys()),
        "hex_r9": sorted(hex_counts["r9"].keys()),
    }
    # Resolutions for which `hex-r{N}.parquet` exists at outdir root (i.e.
    # picker has a single-file fallback at this resolution).
    single_files = [f"r{res}" for res in HEX_RESOLUTIONS]

    # Per-county / per-muni bboxes for fit-bounds (1st–99th percentile +5% pad,
    # same convention as v1). Keep the same key types so v1 and v2 manifests
    # are interchangeable for these fields.
    def _bbox(sub):
        lat_lo, lat_hi = sub["lat"].quantile([0.01, 0.99])
        lon_lo, lon_hi = sub["lon"].quantile([0.01, 0.99])
        dlat = (lat_hi - lat_lo) * 0.05
        dlon = (lon_hi - lon_lo) * 0.05
        return [
            float(lon_lo - dlon), float(lat_lo - dlat),
            float(lon_hi + dlon), float(lat_hi + dlat),
        ]
    county_bboxes: dict[int, list[float]] = {}
    muni_bboxes: dict[str, list[float]] = {}
    per_year: dict[int, int] = {}
    per_year_county: dict[str, int] = {}
    for cc, sub in base.groupby("cc"):
        if len(sub) < 3:
            continue
        county_bboxes[int(cc)] = _bbox(sub)
        for mc, msub in sub.groupby("mc"):
            if len(msub) < 3:
                continue
            muni_bboxes[f"{int(cc)}-{int(mc)}"] = _bbox(msub)
    for y, sub in base.groupby("year"):
        per_year[int(y)] = int(len(sub))
        for cc, ccsub in sub.groupby("cc"):
            per_year_county[f"{int(y)}-{int(cc):02d}"] = int(len(ccsub))

    year_range = [int(base["year"].min()), int(base["year"].max())]
    manifest = {
        "schema_version": 2,
        "shard_res": SHARD_RES,
        "point_severities": sorted(point_sevs),
        "hex_severities": sorted(hex_sevs),
        "year_range": year_range,
        "shards": shards,
        "single_files": single_files,
        "shard_bboxes": bboxes,
        "row_counts": {
            "points": int(sum(point_counts.values())),
            "hex_r6": int(hex_counts["r6"]),
            "hex_r7": int(sum(hex_counts["r7"].values())),
            "hex_r8": int(sum(hex_counts["r8"].values())),
            "hex_r9": int(sum(hex_counts["r9"].values())),
        },
        # Legacy carry-overs (unchanged from v1's manifest.json — present
        # here so a v2-only client doesn't need to fetch both manifests).
        "county_bboxes": county_bboxes,
        "muni_bboxes": muni_bboxes,
        "by_geocode_src": base["geocode_src"].value_counts().to_dict(),
        "per_year": per_year,
        "per_year_county": per_year_county,
    }

    manifest_path = out / "manifest.v2.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2, default=str)
    print(f"\nWrote manifest to {manifest_path}")
    return (
        f"Export map v2 ("
        f"{manifest['row_counts']['points']:,} points / "
        f"{len(shard_cells)} shards, "
        f"years {year_range[0]}-{year_range[1]})"
    )
