from datetime import datetime as dt
from typing import Tuple

import pandas as pd
from click import option, argument
from utz import err, process
from utz.ymd import dates, YMD

from .base import slack, dry_run_opt, channel_opt
from .channel_client import ChannelClient, DEFAULT_BATCH_SIZE, DEFAULT_MAX_RECS
from ...commit_crashes import CommitCrashes
from ...crash.crash import Crash
from ...paths import fauqstats_relpath, S3_CRASH_LOG_PQT


@slack.command('sync')
@option('-b', '--batch-size', type=int, default=DEFAULT_BATCH_SIZE, help=f'Batch size for paginated fetches from the Slack API (default: {DEFAULT_BATCH_SIZE})')
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x: update existing messages; 2x: delete existing messages and post new ones (default: 0, do nothing)')
@channel_opt
@option('-l', '--crash-log-url', default=S3_CRASH_LOG_PQT, help=f'File containing crash-update history (default: {S3_CRASH_LOG_PQT})')
@option('-m', '--max-recs', type=int, default=DEFAULT_MAX_RECS, help=f"Fetch up to this many messages from Slack, and update cache (as opposed to just reading cached messages; default: {DEFAULT_MAX_RECS})")
@dry_run_opt
@argument('commits', nargs=-1)
def sync(
    batch_size: int,
    start: YMD,
    end: YMD,
    overwrite_existing: int,
    channel: str | None,
    crash_log_url: str,
    max_recs: int | None,
    dry_run: bool,
    commits: Tuple[str, ...],
):
    """Post crashes to the #crash-bot channel in HCCS Slack.

    <COMMIT> argument should be a "Refresh NJSP data" / `njsp refresh-data` commit hash (that
    updates `data/FAUQStats*.xml` files).
    """
    if not commits:
        cur_year = dt.now().year
        commit = process.line('git', 'log', '-1', '--format=%h', '--', fauqstats_relpath(cur_year), fauqstats_relpath(cur_year - 1))
        commits = (commit,)

    client = ChannelClient(
        channel=channel,
        dry_run=dry_run,
        batch_size=batch_size,
        max_recs=max_recs,
    )
    crashes_log = pd.read_parquet(crash_log_url)

    for commit in commits:
        err(f"Processing commit {commit}")
        cc = CommitCrashes(commit)
        crashes = cc.adds_df

        if crashes.empty:
            err("No new crashes found, continuing")
            continue

        if start:
            crashes = crashes[crashes.dt.dt.date >= start.date]
        if end:
            crashes = crashes[crashes.dt.dt.date < end.date]

        crashes = crashes.sort_values('dt')
        err(f"{len(crashes)} crashes:")
        err(str(crashes))

        for _, r in crashes.iterrows():
            crash = Crash.load(r)
            client.sync_crash(
                crash,
                crashes_log=crashes_log,
                overwrite_existing=overwrite_existing,
            )
