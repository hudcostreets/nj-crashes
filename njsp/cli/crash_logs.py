from os.path import splitext

import click
import pandas as pd
from utz import err

from njdot.rawdata import singleton
from njsp.cli.base import njsp
from njsp.crash_log import get_crashes_df, DEFAULT_ROOT_SHA
from njsp.paths import CRASHES_RELPATH

# Enforce column order, otherwise DFs built using 1 or more -a/--append-to chains can have different column orders (e.g.
# STREET, HIGHWAY, and INJURIES may each appear for the first time, in a given FAUQStats XML file, in different orders).
COLS = [
    'rundate', 'kind',
    'CCODE', 'CNAME',
    'MCODE', 'MNAME',
    'STREET', 'HIGHWAY', 'LOCATION',
    'FATALITIES', 'FATAL_D', 'FATAL_P', 'FATAL_T', 'FATAL_B', 'INJURIES',
    'dt',
]


@njsp.command("crash_logs")
@click.option('-a', '--append-to', help='Append to existing file (typically `crash_logs/<root>.pqt`')
@click.option("-f", "--write-dupes", is_flag=True, help="Write output even when duplicate rows are detected")
@click.option('-h', '--head', help='Ref to begin ancestor-traversal from')
@click.option("-i", "--in-place", is_flag=True, help="Overwrite the input file -a/--append-to")
@click.option("-o", "--out-path", help="Path to save the output")
@click.option("-p", "--load-parquet", is_flag=True, help=f"Load crashes from {CRASHES_RELPATH} (instead of FAUQStats XML files)")
@click.option("-r", "--root", help=f"Ref to end at; if -a/--append-to is passed, defaults to the latest SHA in that DataFrame, {DEFAULT_ROOT_SHA} otherwise")
@click.option("-s", "--since", help="Date to start from")
@click.option("-v", "--verbose", is_flag=True, help="Print debug info")
def crash_logs(append_to, write_dupes, head, in_place, out_path, load_parquet, root, since, verbose):
    if append_to:
        if not root:
            prefix = pd.read_parquet(append_to)
            df_sha = prefix.reset_index(level=0)
            latest_prefix_sha = df_sha.rundate.idxmax()
            root = latest_prefix_sha
            latest_rundate = singleton(df_sha.loc[latest_prefix_sha, 'rundate'].tolist())
            err(f"Using latest SHA from {append_to} as root: {root} (rundate {latest_rundate})")
        if in_place:
            if out_path:
                raise ValueError("Cannot use -i/--in-place and -o/--out-path together")
            out_path = append_to
    elif in_place:
        raise ValueError("Cannot use -i/--in-place without -a/--append-to")

    df = get_crashes_df(head=head, root=root, since=since, load_pqt=load_parquet, log=verbose)
    cols = [
        col
        for col in COLS
        if col in df
    ]
    df = df[cols]
    if append_to:
        prefix = pd.read_parquet(append_to)
        df = (
            pd.concat([prefix, df])
            .reset_index()
            .sort_values(['accid', 'rundate'])
            .set_index(['accid', 'sha'])
        )
        reset = df.reset_index()
        dupes = reset[reset.duplicated(keep=False)]
        if not dupes.empty:
            dupe_shas = dupes.reset_index(level=1).sha.unique()
            msg = f"Found {len(dupes)} duplicate rows, from SHAs: {dupe_shas}"
            if write_dupes:
                err(msg)
            else:
                raise ValueError(msg)

    if out_path:
        stem, xtn = splitext(out_path)
        if xtn == ".pqt":
            df.to_parquet(out_path)
        elif xtn == ".csv":
            df.to_csv(out_path)
        else:
            raise ValueError(f"Unrecognized extension: {xtn}")
    else:
        print(df)
