"""Export the interactive map's geometry manifest (`manifest.v2.json`).

Layout under {outdir} (typically www/public/njdot/map/v2):

    manifest.v2.json

That's the whole output now. This command used to also emit the H3-sharded
`points/{r5}.parquet` + `hex-r{6,7,8,9}` tree that the client fetched straight
from R2 — the "map v2" stack. All crash cells now come from the cells-api
worker (`/v1/cells`, S2 grid), so those artifacts had no reader; they went
away with `specs/h3-removal.md` Phase 3, and with them the last H3 dependency
in the pipeline.

What the client still needs from here is purely non-spatial-index metadata:
`county_bboxes` / `muni_bboxes` (fit-bounds when you navigate to `/c/hudson`
or a muni) and `year_range` (the year-slider's bounds). See
`www/src/map/v2.ts` and `CrashMapSection`.
"""
import json
from pathlib import Path

import click
import pandas as pd

from njdot.load import load_crashes_with_aashto

from .base import njdot
from njdot.map_base import _build_base


@njdot.command("export_map_v2")
@click.option("-o", "--outdir", default="www/public/njdot/map/v2", help="Output dir")
@click.option("-s", "--severities", default="i,f,p", help="Severities to include when computing bboxes / year range")
@click.option("--years", default=None, help="Year range, e.g. 2019:2023 (inclusive, default: all)")
def export_map_v2(outdir, severities, years):
    """Export `manifest.v2.json`: county/muni fit-bboxes + year range."""
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

    sevs = {s.strip() for s in severities.split(",") if s.strip()}
    print(f"  severities: {sorted(sevs)}")

    base = _build_base(df, sevs)
    print(f"  with lat/lon: {len(base):,}")

    base["year"] = (
        pd.to_datetime(base["dt"] * 60, unit="s", utc=True).dt.year.astype("int16")
    )

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)

    # Per-county / per-muni bboxes for fit-bounds (1st–99th percentile +5% pad,
    # same convention as v1).
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
    for cc, sub in base.groupby("cc"):
        if len(sub) < 3:
            continue
        county_bboxes[int(cc)] = _bbox(sub)
        for mc, msub in sub.groupby("mc"):
            if len(msub) < 3:
                continue
            muni_bboxes[f"{int(cc)}-{int(mc)}"] = _bbox(msub)

    year_range = [int(base["year"].min()), int(base["year"].max())]
    manifest = {
        # v3 = the slim manifest: no `shards` / `shard_bboxes` / `single_files`
        # (H3 R2-direct fetch metadata) and no unread count breakdowns.
        "schema_version": 3,
        "year_range": year_range,
        "county_bboxes": county_bboxes,
        "muni_bboxes": muni_bboxes,
    }

    manifest_path = out / "manifest.v2.json"
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2, default=str)
    size_kb = manifest_path.stat().st_size / 1024
    print(f"\nWrote manifest to {manifest_path} ({size_kb:.1f} KB)")
    return (
        f"Export map v2 ("
        f"{len(county_bboxes)} counties / {len(muni_bboxes)} munis, "
        f"years {year_range[0]}-{year_range[1]})"
    )
