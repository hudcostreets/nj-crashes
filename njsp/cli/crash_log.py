from os.path import splitext

import click
import pandas as pd
from utz import singleton

from nj_crashes.utils import TZ
from nj_crashes.utils.s3 import output_ctx, input_ctx
from nj_crashes.utils.log import err
from njsp.cli.base import njsp
from njsp.crash_log import get_crashes_df, DEFAULT_ROOT_SHA
from njsp.paths import CRASHES_RELPATH, S3_CRASH_LOG_PQT, S3_CRASH_LOG_DB

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


TBL = "crash_log"


def load(path: str) -> pd.DataFrame:
    xtn = splitext(path)[1]
    if xtn in [".pqt", ".parquet"]:
        return pd.read_parquet(path)
    elif xtn == ".csv":
        return pd.read_csv(path)
    elif xtn in [".db", ".sqlite"]:
        with input_ctx(path) as local_path:
            db_uri = f'sqlite:///{local_path}'
            return pd.read_sql(TBL, db_uri)


def save(df: pd.DataFrame, path: str):
    stem, xtn = splitext(path)
    if xtn in [".pqt", ".parquet"]:
        df.to_parquet(path)
    elif xtn == ".csv":
        df.to_csv(path)
    elif xtn in [".db", ".sqlite"]:
        with output_ctx(path) as local_path:
            db_uri = f'sqlite:///{local_path}'
            df.to_sql(TBL, db_uri, if_exists="replace")
            err(f"Wrote crash log to {local_path}")
    else:
        raise ValueError(f"Unrecognized extension: {xtn}")


@njsp.group("crash_log")
def crash_log():
    pass


@crash_log.command
@click.option('-a', '--append-to', help='Append to existing file (typically `njsp/data/crash-log.parquet`')
@click.option("-f", "--write-dupes", is_flag=True, help="Write output even when duplicate rows are detected")
@click.option('-h', '--head', help='Ref to begin ancestor-traversal from')
@click.option("-i", "--in-place", is_flag=True, help="Overwrite the input file -a/--append-to")
@click.option('-n', '--dry-run', is_flag=True, help='Print the number of rows that would be dropped, but do not actually drop them')
@click.option("-o", "--out-paths", multiple=True, help="Path to save the output")
@click.option("-r", "--root", help=f"Ref to end at; if -a/--append-to is passed, defaults to the latest SHA in that DataFrame, {DEFAULT_ROOT_SHA} otherwise")
@click.option("-s", "--since", help="Date to start from")
@click.option('--s3', is_flag=True, help=f"Shorthand for CI use: `-a {S3_CRASH_LOG_PQT} -i -o {S3_CRASH_LOG_DB}`")
@click.option("-v", "--verbose", is_flag=True, help="Print debug info")
def compute(append_to, write_dupes, head, in_place, dry_run, out_paths, root, since, s3, verbose):
    out_paths = list(out_paths) if out_paths else []
    if s3:
        if append_to:
            raise ValueError("Cannot use --s3 with -a/--append-to")
        append_to = S3_CRASH_LOG_PQT
        out_paths += [S3_CRASH_LOG_DB]
        in_place = True

    prefix = None
    if append_to:
        if not root:
            prefix = load(append_to)
            df_sha = prefix.reset_index(level=0)
            latest_prefix_sha = df_sha.rundate.idxmax()
            root = latest_prefix_sha
            latest_rundate = singleton(df_sha.loc[[latest_prefix_sha], 'rundate'].tolist())
            err(f"Using latest SHA from {append_to} as root: {root} (rundate {latest_rundate})")
        if in_place:
            out_paths.append(append_to)
    elif in_place:
        raise ValueError("Cannot use -i/--in-place without -a/--append-to")

    df = get_crashes_df(head=head, root=root, since=since, log=verbose)
    cols = [
        col
        for col in COLS
        if col in df
    ]
    df = df[cols]
    if append_to:
        if prefix is None:
            prefix = load(append_to)
        reset = (
            pd.concat([prefix, df])
            .reset_index()
        )
        dupes = reset[reset.duplicated(keep=False)]
        if not dupes.empty:
            dupe_shas = dupes.reset_index(level=1).sha.unique()
            msg = f"Found {len(dupes)} duplicate rows, from SHAs: {dupe_shas}"
            if write_dupes:
                err(msg)
            else:
                raise ValueError(msg)

        err(f"Found {len(df)} new rows, appending to {len(prefix)} from {append_to}:")
        err(df)
        df = (
            reset
            .sort_values(['accid', 'rundate'])
            .set_index(['accid', 'sha'])
        )

    if out_paths:
        if dry_run:
            err(f"DRY RUN: would write {len(df)} rows to {out_paths}")
        else:
            for out_path in out_paths:
                save(df, out_path)
    else:
        print(df)


@crash_log.command
@click.option("-i", "--in-place", is_flag=True, help="Overwrite the input file -a/--append-to")
@click.option('-n', '--dry-run', is_flag=True, help='Print the number of rows that would be dropped, but do not actually drop them')
@click.option("-o", "--out-path", help="Path to save the output")
@click.option('-r', '--rundate', help='Rundate to end at (exclusive)')
@click.option('-s', '--sha', help='Ref to end at (exclusive)')
@click.argument("path")
def truncate(in_place, dry_run, out_path, rundate, sha, path):
    df = load(path)
    if in_place:
        if out_path:
            raise ValueError("Cannot use -i/--in-place and -o/--out-path together")
        out_path = path
    if not out_path:
        raise ValueError("Must pass -o/--out-path xor -i/--in-place")

    if rundate:
        if sha:
            raise ValueError("Pass -r/--rundate xor -s/--sha")
        rundate = pd.to_datetime(rundate).tz_localize(TZ)
        keep_mask = df.rundate < rundate
        df = df[keep_mask]
        num_to_drop = (~keep_mask).sum()
        err(f"Dropped {num_to_drop} rows < {rundate}")
    elif sha:
        sha_entries = df.reset_index(level=0).loc[sha, 'rundate']
        sha_rundate = singleton(sha_entries)
        keep_mask = df.rundate < sha_rundate
        df = df[keep_mask]
        num_to_drop = (~keep_mask).sum()
        err(f"Dropped {num_to_drop} rows < {sha_rundate} ({sha})")
    else:
        raise ValueError("Pass -r/--rundate xor -s/--sha")

    if not dry_run:
        save(df, out_path)
