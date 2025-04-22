from typing import Tuple

import pandas as pd
from utz import solo
from utz.cli import multi, opt, arg
from utz.ymd import dates, YMD

from nj_crashes.utils.github import expand_refspec
from .base import slack, channel_client_opts
from .channel_client import ChannelClient
from ...crash import Log
from ...crash.log import versions
from ...paths import S3_CRASH_LOG_PQT


@slack.command
@channel_client_opts
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@opt('-f', '--overwrite-existing', count=True, help='1x: update existing messages; 2x: delete existing messages and post new ones (default: 0, do nothing)')
@opt('-l', '--crash-log-url', default=S3_CRASH_LOG_PQT, help=f'File containing crash-update history (default: {S3_CRASH_LOG_PQT})')
@multi('-r', '--refspec', 'refspecs', help='Sync crash updates from these Git SHAs (or ranges) in the crash-log')
@arg('accids', type=int, nargs=-1)
def sync(
    client: ChannelClient,
    start: YMD,
    end: YMD | None,
    overwrite_existing: int,
    crash_log_url: str,
    refspecs: tuple[str, ...],
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
    for accid, df in iter(crashes_log.groupby('accid')):
        crash_log = Log(accid, versions(df))
        try:
            client.sync_crash(
                accid=accid,
                crash_log=crash_log,
                overwrite_existing=overwrite_existing,
            )
        except Exception:
            raise RuntimeError(f"Failed to sync crash {accid=}")
