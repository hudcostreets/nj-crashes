#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow"]
# ///
"""Generate `www/public/data/harmonization/county_lag.json` — per-county
fatal/injury/PDO counts for the two most-recent AASHTO years. The
harmonization page renders this to visualize the 2025 fatal-
classification lag concentration (Monmouth/Essex/Mercer drop to ~30-40%
of 2024 fatal counts while their injury/PDO counts are normal).

Reads pure AASHTO (NOT the supplemented version) so the lag is visible.
"""
import json
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd

err = partial(print, file=sys.stderr)


@click.command()
@click.option("-i", "--in-parquet", default="njdot/data/aashto_combined_crashes.parquet")
@click.option("-o", "--out-json", default="www/public/data/harmonization/county_lag.json")
def main(in_parquet: str, out_json: str):
    a = pd.read_parquet(in_parquet)
    a["y"] = a["dt"].dt.year
    g = a.groupby(["cc", "y", "severity"]).size().unstack("severity", fill_value=0).unstack("y", fill_value=0)
    g.columns = [f"{s}_{y}" for s, y in g.columns]

    # Pick the two most-recent years present.
    years = sorted({int(c.split("_")[1]) for c in g.columns})
    y_prev, y_cur = years[-2], years[-1]

    out = {"years": [y_prev, y_cur], "counties": []}
    for cc, row in g.iterrows():
        out["counties"].append({
            "cc": int(cc),
            "f_prev": int(row[f"f_{y_prev}"]),
            "f_cur":  int(row[f"f_{y_cur}"]),
            "i_prev": int(row[f"i_{y_prev}"]),
            "i_cur":  int(row[f"i_{y_cur}"]),
            "p_prev": int(row[f"p_{y_prev}"]),
            "p_cur":  int(row[f"p_{y_cur}"]),
        })

    out_path = Path(out_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    err(f"Wrote {out_path} ({len(out['counties'])} counties; {y_prev} → {y_cur})")


if __name__ == "__main__":
    main()
