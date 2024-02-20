import pandas as pd
from click import option
from typing import Optional
from utz import err
from utz.ymd import dates, YMD

from .base import slack
from .channel_client import ChannelClient, CHANNEL_OPTS
from ...commit_crashes import crash_str, CommitCrashes
from ...crashes import Crash


def sync_crash(
        r,
        client: ChannelClient,
        commit: Optional[str],
        overwrite_existing: int = 0,
        dry_run: int = 0,
) -> None:
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
            m = f"ACCID {accid} deleting"
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                client.delete_msg(ts=ts, accid=accid)
            post_msg()
        elif new_text != text or overwrite_existing:
            if new_text != text:
                m = f"ACCID {accid} text doesn't match:\n-{text}\n+{new_text}"
            else:
                m = f"ACCID {accid} overwriting message: {text}"
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                client.update_msg(ts=ts, accid=accid, text=new_text)
        else:
            err(f"ACCID {accid} text matches: {text}")
    else:
        post_msg()


@slack.command('sync')
@option('-c', '--commit', 'commits', multiple=True, help='Commits to parse new crashes from')
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x')
@option(*CHANNEL_OPTS, help='Slack channel ID to post to; defaults to $SLACK_CHANNEL_ID')
@option('-m', '--fetch-messages', type=int, default=1000, help="Fetch messages from Slack and update cache (as opposed to just reading cached messages")
@option('-n', '--dry-run', count=True, help="Avoid Slack API requests, cache updates, etc.")
def sync(commits, start: YMD, end: YMD, overwrite_existing, channel, fetch_messages: Optional[int], dry_run: int):
    if commits:
        ccs = [ CommitCrashes(commit) for commit in commits ]
        crashes = pd.concat([cc.adds_df for cc in ccs])
    else:
        crashes = pd.read_parquet('data/crashes.pqt')

    if crashes.empty:
        err("No new crashes found, breaking")
        return

    if start:
        crashes = crashes[crashes.dt.dt.date >= start.date]
    if end:
        crashes = crashes[crashes.dt.dt.date < end.date]

    if len(commits) == 1:
        [commit] = commits
    else:
        commit = None

    crashes = crashes.sort_values('dt')
    err(f"{len(crashes)} crashes:")
    err(str(crashes))

    client = ChannelClient(channel=channel, dry_run=dry_run)
    cache = client.cache
    if fetch_messages:
        client.fetch_messages(limit=fetch_messages)

    crashes.apply(sync_crash, axis=1, client=client, commit=commit, overwrite_existing=overwrite_existing)
    cache.close()
