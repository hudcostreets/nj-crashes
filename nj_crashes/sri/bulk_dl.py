#!/usr/bin/env python3
"""Bulk-download NJ Standard Route ID + Milepost feature layer.

Replaces the per-SRI ArcGIS scrape in `nj_crashes/sri/cli.py`. Walks
all ~896k tenth-mile points via `resultOffset` pagination, writes to a
single parquet with columns: SRI, MP, SLD_NAME, Second_Name,
ROUTE_SUBT, lon, lat.

Source: ArcGIS FeatureServer
  https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/
    New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0/

Output: `njdot/data/nj_mp_tenths.parquet` (DVX-track)

Run:
    nj_crashes/sri/bulk_dl.py                              # standard
    nj_crashes/sri/bulk_dl.py -o /tmp/mp.parquet -c 20     # custom
"""
import sys
import time
from functools import partial
from pathlib import Path

import click
import pandas as pd
import requests
from concurrent.futures import ThreadPoolExecutor

err = partial(print, file=sys.stderr)

FS_BASE = (
    "https://services.arcgis.com/HggmsDF7UJsNN1FK/arcgis/rest/services/"
    "New_Jersey_Standard_Route_Id_And_Milepost/FeatureServer/0"
)
PAGE_SIZE = 1000  # FeatureServer's `maxRecordCount`
FIELDS = ["SRI", "MP", "SLD_NAME", "Second_Name", "ROUTE_SUBT", "Longitude", "Latitude"]


def fetch_page(offset: int, retries: int = 3) -> list[dict]:
    """Return the `attributes` of one page of MP features."""
    params = {
        "where": "1=1",
        "outFields": ",".join(FIELDS),
        "returnGeometry": "false",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
        "orderByFields": "OBJECTID",  # stable pagination
        "f": "json",
    }
    last_exc = None
    for attempt in range(retries):
        try:
            r = requests.get(f"{FS_BASE}/query", params=params, timeout=60)
            r.raise_for_status()
            j = r.json()
            if "error" in j:
                raise RuntimeError(f"ArcGIS error at offset={offset}: {j['error']}")
            return [f["attributes"] for f in j.get("features", [])]
        except (requests.RequestException, ValueError, RuntimeError) as e:
            last_exc = e
            wait = 1.5 ** attempt
            err(f"  retry {attempt + 1}/{retries} for offset={offset} after {wait:.1f}s ({e})")
            time.sleep(wait)
    raise RuntimeError(f"giving up on offset={offset}: {last_exc}")


@click.command("bulk-dl")
@click.option("-c", "--concurrency", default=8, show_default=True, type=int)
@click.option("-o", "--output", default="njdot/data/nj_mp_tenths.parquet", show_default=True)
def main(concurrency: int, output: str):
    """Paginate the MP FeatureServer and write all rows to parquet."""
    err(f"Counting total rows…")
    r = requests.get(f"{FS_BASE}/query", params={"where": "1=1", "returnCountOnly": "true", "f": "json"}, timeout=30)
    r.raise_for_status()
    total = r.json()["count"]
    err(f"Total: {total:,} rows; {total // PAGE_SIZE + 1} pages @ {PAGE_SIZE}/page")

    offsets = list(range(0, total, PAGE_SIZE))
    all_rows: list[dict] = []
    done = 0
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        for rows in ex.map(fetch_page, offsets):
            all_rows.extend(rows)
            done += 1
            if done % 20 == 0 or done == len(offsets):
                err(f"  {done}/{len(offsets)} pages, {len(all_rows):,} rows so far")

    df = pd.DataFrame(all_rows).rename(columns={"Longitude": "lon", "Latitude": "lat"})
    err(f"Fetched {len(df):,} rows. Columns: {list(df.columns)}")
    if len(df) != total:
        err(f"WARNING: row count mismatch — expected {total:,}, got {len(df):,}")

    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    err(f"Wrote {out} ({out.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
