"""Column-prune + zstd + h3-sort the hex-sld sidecar for cells-api's
in-worker join.

Input: `www/public/njdot/map/v2/hex-sld.parquet` (15 MB, 10 cols)
Output: `data/cells/hex-sld.parquet` (target ~5-6 MB, 5 cols)

Cols kept: h3, sld_name, cross_sld_name, mun, county — the four
tooltip fields plus the join key. Everything else (sri/mp/route_subt/
cross_sri/cross_mp) is dropped.

Sort by h3 so parquet row-group stats give hyparquet clean pruning
ranges (h3 hex-strings sort roughly by res-then-region — r6 cells
"862…" cluster in one row group, r11 cells "8b…" in another).

Worker-side: single R2 read at module init, in-memory Map keyed by
h3. Cells at data_res > 11 look up their r11 ancestor via
`cellToParent` — same fallback as the legacy client `useHexSld.lookup`.
"""
import subprocess
from functools import partial
from pathlib import Path
from sys import stderr

import click
import pandas as pd

from .base import njdot

err = partial(print, file=stderr)


@njdot.command("reshard_hex_sld")
@click.option("-s", "--sld-path", default="www/public/njdot/map/v2/hex-sld.parquet", show_default=True)
@click.option("-o", "--output", default="data/cells/hex-sld.parquet", show_default=True)
@click.option("-r", "--row-group-size", default=50_000, show_default=True, help="Rows per row-group (for range pruning)")
def reshard_hex_sld(sld_path: str, output: str, row_group_size: int):
    err(f"Loading sidecar: {sld_path}")
    df = pd.read_parquet(sld_path, columns=["h3", "sld_name", "cross_sld_name", "mun", "county"])
    err(f"  {len(df):,} rows")

    err("Sorting by h3 (row-group range-pruning)")
    df = df.sort_values("h3").reset_index(drop=True)

    Path(output).parent.mkdir(parents=True, exist_ok=True)
    err(f"Writing zstd-compressed with row_group_size={row_group_size:,}")
    df.to_parquet(output, index=False, compression="zstd", row_group_size=row_group_size)

    size_bytes = Path(output).stat().st_size
    err(f"→ {output} ({len(df):,} rows, {size_bytes / 1024 / 1024:.2f} MB)")
    err(f"  ratio vs source: {size_bytes / Path(sld_path).stat().st_size:.1%}")
    err(f"Sample row-group ranges (h3 min→max):")
    try:
        subprocess.run(["pqm", output], check=False, stderr=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, timeout=5)
    except Exception:
        pass
