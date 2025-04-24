from contextlib import nullcontext
from functools import wraps
from os.path import splitext
from urllib.parse import urlparse

import pandas as pd
from pandas import DataFrame
from utz import call, ctxs, solo, s3
from utz.cli import arg, flag, opt

from nj_crashes.utils import TZ
from nj_crashes.utils.log import err, none, Log
from nj_crashes.utils.s3 import output_ctx, input_ctx
from njsp.cli.base import njsp
from njsp.commit_crashes import DEFAULT_ROOT_SHA_PARENT
from njsp.crash_log import get_crash_log
from njsp.paths import S3_CRASH_LOG_PQT, S3_CRASH_LOG_DB

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


def load(url: str) -> DataFrame:
    xtn = splitext(url)[1]
    if xtn in [".pqt", ".parquet"]:
        return pd.read_parquet(url)
    elif xtn == ".csv":
        return pd.read_csv(url)
    elif xtn in [".db", ".sqlite"]:
        with input_ctx(url) as local_path:
            db_uri = f'sqlite:///{local_path}'
            return pd.read_sql(TBL, db_uri)
    else:
        raise ValueError(f"Unrecognized extension: {xtn}")

def save(df: DataFrame, path: str | None = None):
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
        raise ValueError(f"{path}: unrecognized extension: {xtn}")


@njsp.group("crash_log")
def crash_log():
    """Maintain a history of crash-records adds/updates/deletes."""
    pass


def crash_log_cmd(fn):

    @crash_log.command
    @opt('-a', '--append-to', help='Append to existing file (typically `njsp/data/crash-log.parquet`')
    @flag("-i", "--in-place", help="Overwrite the input file -a/--append-to")
    @flag('-n', '--dry-run', help='Print the number of rows that would be dropped, but do not actually drop them')
    @opt("-o", "--out-paths", multiple=True, help="Path to save the output")
    @opt("-r", "--root", help=f"Ref to end at; if -a/--append-to is passed, defaults to the latest SHA in that DataFrame, {DEFAULT_ROOT_SHA_PARENT} otherwise")
    @flag('--s3', 'auto_s3', help=f"Shorthand for CI use: `-a {S3_CRASH_LOG_PQT} -i -o {S3_CRASH_LOG_DB}`")
    @wraps(fn)
    def _fn(
        *args,
        append_to: str | None,
        in_place: bool,
        dry_run: bool,
        out_paths: tuple[str, ...],
        root: str | None,
        auto_s3: bool,
        **kwargs,
    ):
        out_paths = list(out_paths) if out_paths else []
        if auto_s3:
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
                latest_rundate = solo(df_sha.loc[[latest_prefix_sha], 'rundate'])
                err(f"Using latest SHA from {append_to} as root: {root} (rundate {latest_rundate})")
            if in_place:
                out_paths.append(append_to)
        elif in_place:
            raise ValueError("Cannot use -i/--in-place without -a/--append-to")
        elif not root:
            root = DEFAULT_ROOT_SHA_PARENT

        with ctxs([
            s3.atomic_edit(out_path, create_ok=True) if urlparse(out_path).scheme == 's3' else nullcontext(out_path)
            for out_path in out_paths
        ]) as out_paths:
            df = call(
                fn,
                *args,
                append_to=append_to,
                in_place=in_place,
                dry_run=dry_run,
                out_paths=out_paths,
                prefix=prefix,
                root=root,
                auto_s3=auto_s3,
                **kwargs,
            )
            if out_paths:
                if dry_run:
                    err(f"DRY RUN: would write {len(df)} rows to {out_paths}")
                else:
                    for out_path in out_paths:
                        save(df, out_path)
            else:
                print(df)


    return _fn


verbose_flag = flag("-v", "--verbose", callback=lambda ctx, param, val: err if val else none, help="Print debug info")


@crash_log_cmd
@flag("-f", "--write-dupes", help="Write output even when duplicate rows are detected")
@opt('-h', '--head', help='Ref to begin ancestor-traversal from')
@opt("-s", "--since", help="Date to start from")
@verbose_flag
def compute(
    append_to: str | None,
    write_dupes: bool,
    head: str | None,
    prefix: DataFrame | None,
    root: str | None,
    since: str | None,
    verbose: Log,
):
    df = get_crash_log(head=head, root=root, since=since, log=verbose)
    cols = [
        col
        for col in COLS
        if col in df
    ]
    df = df[cols]
    if prefix is not None:
        new_rows = df
        err(f"Found {len(new_rows)} new rows:\n{new_rows}")
        err(f"Appending to {len(prefix)} from {append_to}:")
        df = pd.concat([prefix, new_rows])
        dfr = df.reset_index()
        dupes = dfr[dfr.duplicated(keep=False)]
        if not dupes.empty:
            dupe_shas = dupes.reset_index(level=1).sha.unique()
            msg = f"Found {len(dupes)} duplicate rows, from SHAs: {dupe_shas}"
            if write_dupes:
                err(msg)
            else:
                raise ValueError(msg)
    df = df.sort_values(['accid', 'rundate'])
    err(df)
    return df


@crash_log.command
@flag("-i", "--in-place", help="Overwrite the input file -a/--append-to")
@flag('-n', '--dry-run', help='Print the number of rows that would be dropped, but do not actually drop them')
@opt("-o", "--out-path", help="Path to save the output")
@opt('-r', '--rundate', help='Rundate to end at (exclusive)')
@opt('-s', '--sha', help='Ref to end at (exclusive)')
@arg("path", required=True)
def truncate(
    in_place: bool,
    dry_run: bool,
    out_path: str | None,
    rundate: str | None,
    sha: str | None,
    path: str,
):
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
        sha_rundate = solo(set(sha_entries))
        keep_mask = df.rundate < sha_rundate
        df = df[keep_mask]
        num_to_drop = (~keep_mask).sum()
        err(f"Dropped {num_to_drop} rows < {sha_rundate} ({sha})")
    else:
        raise ValueError("Pass -r/--rundate xor -s/--sha")

    if not dry_run:
        save(df, out_path)
