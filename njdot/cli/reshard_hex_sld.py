"""Local-test helper: derive `pyramid_sld/s{shard_res}_r{data_res}/{shard}.parquet`
from the existing `hex-sld.parquet` sidecar + a counts-pyramid manifest.

Used to smoke-test the cells-api multiplex join without waiting for the
full KDTree/PIP rebuild. Production path (`export_hex_sld_pyramid`) will
do this natively, sourcing centroids directly from the crash data.

Input:
- `hex-sld.parquet` — cells at r6-r11 with sld_name/cross_sld_name/mun/county
- `manifest.json` — counts-pyramid combos to mirror

Output:
- `pyramid_sld/s{shard_res}_r{data_res}/{shard_cell}.parquet` per combo,
  with columns [h3, sld_name, cross_sld_name, mun, county], zstd.

For `data_res > 11` (finer than the sidecar), each cell inherits its
ancestor's sld via `cell_to_parent(cell, 11)` — same fallback as the
legacy `useHexSld.lookup` walk-up.
"""
import json
from functools import partial
from pathlib import Path
from sys import stderr

import click
import h3
import pandas as pd

from .base import njdot

err = partial(print, file=stderr)

SLD_MAX_RES = 11  # the sidecar's finest available res


@njdot.command("reshard_hex_sld")
@click.option("-s", "--sld-path", default="www/public/njdot/map/v2/hex-sld.parquet", show_default=True)
@click.option("-m", "--manifest-path", default="data/cells/manifest.json", show_default=True)
@click.option("-o", "--out-root", default="data/cells/pyramid_sld", show_default=True)
def reshard_hex_sld(sld_path: str, manifest_path: str, out_root: str):
    err(f"Loading sidecar: {sld_path}")
    sld = pd.read_parquet(sld_path, columns=["h3", "sld_name", "cross_sld_name", "mun", "county"])
    err(f"  {len(sld):,} rows")
    # Key sidecar by h3 for parent-walk fallback lookups.
    sld_by_h3 = sld.set_index("h3", drop=False)

    with open(manifest_path) as f:
        manifest = json.load(f)
    combos = manifest.get("pyramid_combos", [])
    err(f"Manifest combos: {len(combos)}")

    out_root_p = Path(out_root)
    out_root_p.mkdir(parents=True, exist_ok=True)

    for combo in combos:
        shard_res = combo["shard_res"]
        data_res = combo["data_res"]
        shard_cells = combo["shard_cells"]
        subdir = out_root_p / f"s{shard_res}_r{data_res}"
        subdir.mkdir(parents=True, exist_ok=True)

        # Which cells at data_res have data? Enumerate from the counts
        # pyramid — mirror it exactly so every counts row has a matching
        # sld row (or a soft-fail miss).
        counts_root = Path("data/cells/pyramid") / f"s{shard_res}_r{data_res}"
        emitted = 0
        for shard_cell in shard_cells:
            counts_pq = counts_root / f"{shard_cell}.parquet"
            if not counts_pq.exists():
                continue
            # Read only the h3 column for this shard.
            h3_col = f"h3_r{data_res}"
            try:
                raw = pd.read_parquet(counts_pq, columns=[h3_col])[h3_col].unique()
            except Exception as e:
                err(f"  skip {counts_pq}: {e}")
                continue
            # Counts pyramid stores h3 as INT64; sidecar / worker wire format
            # is hex string. Convert once here.
            cells = [f"{int(v):015x}" for v in raw]

            # Attach sld — direct hit at data_res if the sidecar covers it,
            # else walk up to r11 (the sidecar's floor).
            lookup_res = min(data_res, SLD_MAX_RES)
            if lookup_res == data_res:
                keys = cells
            else:
                keys = [h3.cell_to_parent(c, lookup_res) for c in cells]
            sld_rows = sld_by_h3.reindex(keys)
            out_df = pd.DataFrame({
                "h3": cells,
                "sld_name": sld_rows["sld_name"].values,
                "cross_sld_name": sld_rows["cross_sld_name"].values,
                "mun": sld_rows["mun"].values,
                "county": sld_rows["county"].values,
            })
            out_path = subdir / f"{shard_cell}.parquet"
            out_df.to_parquet(out_path, index=False, compression="zstd")
            emitted += 1
        err(f"  s{shard_res}_r{data_res}: emitted {emitted}/{len(shard_cells)} shards")
    err(f"Done → {out_root}")
