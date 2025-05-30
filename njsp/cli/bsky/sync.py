import json
from os.path import join, exists
from time import sleep
from typing import Tuple

import pandas as pd
from utz import solo
from utz.cli import flag, opt, arg, multi
from utz.ymd import dates, YMD

from nj_crashes import ROOT_DIR
from nj_crashes.utils.github import expand_refspec
from nj_crashes.utils.log import err
from .base import bsky
from .client import Client
from .utils import HANDLE
from ...crash import Log
from ...crash.log import versions
from ...paths import S3_CRASH_LOG_PQT


@bsky.command
@dates(default_start=YMD(2020), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@flag('-f', '--overwrite-cache')
@opt('-l', '--crash-log-url', default=S3_CRASH_LOG_PQT, help=f'File containing crash-update history (default: {S3_CRASH_LOG_PQT})')
@flag('-n', '--dry-run', help="Avoid Slack API requests, cache updates, etc.")
@multi('-r', '--refspec', 'refspecs', help='Sync crash updates from these Git SHAs (or ranges) in the crash-log')
@multi('-s', '--retry-intervals', parse=float, help='Sequence of intervals (in seconds) to sleep when fetching newly-created posts (comma-delimited)')
@opt('-S', '--accid-sleep-s', default=1., help='Sleep this many seconds between threads / "ACCID"s')
@arg('accids', type=int, nargs=-1)
def sync(
    start: YMD,
    end: YMD | None,
    overwrite_cache: bool,
    crash_log_url: str,
    dry_run: bool,
    refspecs: tuple[str, ...],
    retry_intervals: tuple[float, ...],
    accid_sleep_s: float,
    accids: Tuple[int, ...],
):
    """Post crashes to the #crash-bot channel in HCCS Slack.

    <COMMIT> argument should be a "Refresh NJSP data" / `njsp refresh-data` commit hash (that
    updates `data/FAUQStats*.xml` files).
    """
    crashes_log = pd.read_parquet(crash_log_url)
    if refspecs:
        if accids:
            raise ValueError("Cannot specify both --ref and accids")
        reset = crashes_log.reset_index()
        l, n = solo(reset.sha.apply(len).value_counts().to_dict())
        refs = [
            sha[:l]
            for refspec in refspecs
            for sha in expand_refspec(refspec, 'data')
        ]
        err("Checking commits:\n\t" + "\n\t".join(refs))
        accids = reset.loc[reset.sha.isin(refs), 'accid'].unique().tolist()
        crashes_log = crashes_log.loc[list(accids)]
    elif accids:
        crashes_log = crashes_log.loc[list(accids)]

    # First crash-log entry for each crash ("accid")
    first_dates = crashes_log.groupby(level=0)['dt'].min().dt.date
    msk = first_dates >= start.date
    if end:
        msk = msk & (first_dates < end.date)
    valid_keys = first_dates[msk].index
    crashes_log = crashes_log[crashes_log.index.get_level_values(0).isin(valid_keys)]
    crashes_log = crashes_log.reset_index()

    client = Client(
        dry_run=dry_run,
        overwrite_cache=overwrite_cache,
    )
    all_new_posts = []
    try:
        for accid, df in iter(crashes_log.groupby('accid')):
            crash_log = Log(accid, versions(df))
            try:
                new_posts, exc = client.sync_crash(
                    accid=accid,
                    crash_log=crash_log,
                    retry_intervals=retry_intervals,
                )
                all_new_posts += new_posts
                if exc:
                    raise exc
                if accid_sleep_s and not dry_run:
                    err(f"Sleeping {accid_sleep_s}s between ACCIDs...")
                    sleep(accid_sleep_s)
            except Exception:
                raise RuntimeError(f"Failed to sync crash {accid=}")
    finally:
        if all_new_posts:
            cache_path = join(ROOT_DIR, ".bsky", "cache", f"{HANDLE}.json")
            if exists(cache_path):
                with open(cache_path, 'r') as f:
                    arr = json.load(f)
            else:
                arr = []
            arr.extend([ new_post.model_dump() for new_post in all_new_posts ])
            with open(cache_path, 'w') as f:
                json.dump(arr, f)
            err(f"Saved {len(all_new_posts)} new posts to {cache_path=} ({len(arr)} total)")
