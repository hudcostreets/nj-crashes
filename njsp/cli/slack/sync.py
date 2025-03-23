import pandas as pd
from click import option, argument
from datetime import datetime as dt
from typing import Optional, Tuple
from utz import env, err, process
from utz.ymd import dates, YMD

from .base import slack
from .channel_client import ChannelClient, CHANNEL_OPTS
from ...commit_crashes import crash_str, CommitCrashes
from ...crashes import Crash
from ...paths import fauqstats_relpath


RED = '\033[31m'
GREEN = '\033[32m'
BLUE = '\033[34m'
RESET = '\033[0m'


def sync_crash(
    r: pd.Series,
    client: ChannelClient,
    commit: Optional[str],
    overwrite_existing: int = 0,
    dry_run: Optional[int] = None,
) -> None:
    if dry_run is None:
        dry_run = client.dry_run
    accid = r.name
    crash = Crash(accid)
    xml_url = crash.xml_url(ref=commit)
    new_text = crash_str(r, github_url=xml_url)
    msg = client.cache.get(accid)

    def post_msg():
        client.post_msg(accid=accid, text=new_text)

    if msg:
        text = msg['text']
        ts = msg['ts']
        if overwrite_existing > 1:
            m = f"{BLUE}ACCID {accid} deleting{RESET}"
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                client.delete_msg(ts=ts, accid=accid)
            post_msg()
        elif new_text != text or overwrite_existing:
            if new_text != text:
                m = f"{BLUE}ACCID {accid} text doesn't match:\n{RED}-{text}\n{GREEN}+{new_text}{RESET}"
            else:
                m = f"{BLUE}ACCID {accid} overwriting message: {text}{RESET}"
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                client.update_msg(ts=ts, accid=accid, text=new_text)
        else:
            err(f"{BLUE}ACCID {accid} text matches: {text}{RESET}")
    else:
        post_msg()


SLACK_CHANNEL_ID_VAR = "SLACK_CHANNEL_ID"
SLACK_CHANNEL_ID = env.get(SLACK_CHANNEL_ID_VAR)

@slack.command('sync')
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x')
@option(*CHANNEL_OPTS, help=f'Slack channel ID to post to; defaults to ${SLACK_CHANNEL_ID_VAR} (currently {SLACK_CHANNEL_ID or "unset"})')
@option('-m', '--fetch-messages', type=int, default=1000, help="Fetch messages from Slack and update cache (as opposed to just reading cached messages")
@option('-n', '--dry-run', count=True, help="Avoid Slack API requests, cache updates, etc.")
@argument('commits', nargs=-1)
def sync(
    commits: Tuple[str, ...],
    start: YMD,
    end: YMD,
    overwrite_existing: int,
    channel: Optional[str],
    fetch_messages: Optional[int],
    dry_run: int,
):
    """Post crashes to the #crash-bot channel in HCCS Slack.

    <COMMIT> argument should be a "Refresh NJSP data" / `njsp refresh-data` commit hash (that
    updates `data/FAUQStats*.xml` files).
    """
    if not commits:
        cur_year = dt.now().year
        commit = process.line('git', 'log', '-1', '--format=%h', '--', fauqstats_relpath(cur_year), fauqstats_relpath(cur_year - 1))
        commits = (commit,)

    client = ChannelClient(channel=channel, dry_run=dry_run)
    cache = client.cache
    if fetch_messages:
        client.fetch_messages(limit=fetch_messages)

    try:
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

            crashes.apply(
                sync_crash,
                axis=1,
                client=client,
                commit=commit,
                overwrite_existing=overwrite_existing,
            )
    finally:
        cache.close()
