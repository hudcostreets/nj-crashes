from typing import Tuple

import pandas as pd
from click import option, argument
from utz.ymd import dates, YMD

from .base import slack, channel_client_opts
from .channel_client import ChannelClient
from ...crash import Log
from ...crash.log import versions
from ...paths import S3_CRASH_LOG_PQT


@slack.command('sync')
@channel_client_opts
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x: update existing messages; 2x: delete existing messages and post new ones (default: 0, do nothing)')
@option('-l', '--crash-log-url', default=S3_CRASH_LOG_PQT, help=f'File containing crash-update history (default: {S3_CRASH_LOG_PQT})')
@argument('accids', type=int, nargs=-1)
def sync(
    client: ChannelClient,
    start: YMD,
    end: YMD | None,
    overwrite_existing: int,
    crash_log_url: str,
    accids: Tuple[int, ...],
):
    """Post crashes to the #crash-bot channel in HCCS Slack.

    <COMMIT> argument should be a "Refresh NJSP data" / `njsp refresh-data` commit hash (that
    updates `data/FAUQStats*.xml` files).
    """
    crashes_log = pd.read_parquet(crash_log_url)
    if accids:
        crashes_log = crashes_log.loc[list(accids)]

    first_dts = crashes_log.groupby(level=0)['dt'].min()
    msk = first_dts >= start.dt
    if end:
        msk = msk & (first_dts < end.dt)
    valid_keys = first_dts[msk].index
    crashes_log = crashes_log[crashes_log.index.get_level_values(0).isin(valid_keys)]

    crashes_log = crashes_log.reset_index()
    for accid, df in iter(crashes_log.groupby('accid')):
        crash_log = Log(accid, versions(df))
        client.sync_crash(
            accid=accid,
            crash_log=crash_log,
            overwrite_existing=overwrite_existing,
        )
