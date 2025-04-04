from datetime import datetime as dt
from typing import Tuple

import pandas as pd
from click import option, argument
from utz import err, process
from utz.ymd import dates, YMD

from .base import slack, dry_run_opt, channel_opt
from .channel_client import ChannelClient, DEFAULT_BATCH_SIZE, DEFAULT_MAX_RECS
from ...commit_crashes import CommitCrashes
from ...crash import Log
from ...crash.crash import Crash
from ...crash.log import versions
from ...paths import fauqstats_relpath, S3_CRASH_LOG_PQT


@slack.command('sync')
@option('-b', '--slack-batch-size', type=int, default=DEFAULT_BATCH_SIZE, help=f'Batch size for paginated fetches from the Slack API (default: {DEFAULT_BATCH_SIZE})')
# @dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x: update existing messages; 2x: delete existing messages and post new ones (default: 0, do nothing)')
@channel_opt
@option('-l', '--crash-log-url', default=S3_CRASH_LOG_PQT, help=f'File containing crash-update history (default: {S3_CRASH_LOG_PQT})')
@option('-m', '--slack-max-recs', type=int, default=DEFAULT_MAX_RECS, help=f"Fetch up to this many messages from Slack, and update cache (as opposed to just reading cached messages; default: {DEFAULT_MAX_RECS})")
@dry_run_opt
@argument('accids', type=int, nargs=-1)
def sync(
    slack_batch_size: int,
    # start: YMD,
    # end: YMD,
    overwrite_existing: int,
    channel: str | None,
    crash_log_url: str,
    slack_max_recs: int | None,
    dry_run: bool,
    accids: Tuple[int, ...],
):
    """Post crashes to the #crash-bot channel in HCCS Slack.

    <COMMIT> argument should be a "Refresh NJSP data" / `njsp refresh-data` commit hash (that
    updates `data/FAUQStats*.xml` files).
    """
    client = ChannelClient(
        channel=channel,
        dry_run=dry_run,
        batch_size=slack_batch_size,
        max_recs=slack_max_recs,
    )
    crashes_log = pd.read_parquet(crash_log_url)
    if accids:
        crashes_log = crashes_log.loc[list(accids)]
    crashes_log = crashes_log.reset_index()
    for accid, df in iter(crashes_log.groupby('accid')):
        crash_log = Log(accid, versions(df))
        # thread = client.accid_thread(accid)
        # msgs = thread.msgs if thread else []
        client.sync_crash(
            accid=accid,
            crash_log=crash_log,
            overwrite_existing=overwrite_existing,
        )

        # if start:
        #     crashes = crashes[crashes.dt.dt.date >= start.date]
        # if end:
        #     crashes = crashes[crashes.dt.dt.date < end.date]

        # crashes = crashes.sort_values('dt')
        # err(f"{len(crashes)} crashes:")
        # err(str(crashes))
