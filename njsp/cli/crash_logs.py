from os.path import splitext

import click
import pandas as pd
from utz import err

from njsp.cli.base import njsp
from njsp.crash_log import get_crashes_df, DEFAULT_ROOT_SHA


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
@click.option("-o", "--out-path", help="Path to save the output")
@click.option("-r", "--root", default=DEFAULT_ROOT_SHA, help="Ref to end at")
@click.option("-s", "--since", help="Date to start from")
@click.option("-v", "--verbose", is_flag=True, help="Print debug info")
@click.option("-x", "--load-xml", is_flag=True, help="Load crashes from FAUQStats XML files (instead of crashes.pqt)")
def crash_logs(append_to, write_dupes, head, out_path, root, since, verbose, load_xml):
    df = get_crashes_df(head=head, root=root, since=since, load_pqt=not load_xml, log=verbose)
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
