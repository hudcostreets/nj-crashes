import pandas as pd
from click import option
from typing import Optional
from utz import err
from utz.ymd import dates, YMD

from .base import slack
from .client import Client, CHANNEL_OPTS, resolve_channel
from ...commit_crashes import crash_str, CommitCrashes
from ...crash import Crash


@slack.command('sync')
@option('-c', '--commit', 'commits', multiple=True, help='Commits to parse new crashes from')
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x')
@option(*CHANNEL_OPTS, help='Slack channel ID to post to; defaults to $SLACK_CHANNEL_ID')
@option('-m', '--fetch-messages', type=int, help="Fetch messages from Slack and update cache (as opposed to just reading cached messages")
@option('-n', '--dry-run', count=True, help="Avoid Slack API requests, cache updates, etc.")
def sync(commits, start: YMD, end: YMD, overwrite_existing, channel, fetch_messages: Optional[int], dry_run: int):
    if commits:
        ccs = [ CommitCrashes(commit) for commit in commits ]
        crashes = pd.concat([ cc.new_df for cc in ccs ])
    else:
        crashes = pd.read_parquet('data/crashes.pqt')

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

    client = Client()
    cache = client.cache

    if fetch_messages:
        client.fetch_messages(limit=fetch_messages, channel=channel, dry_run=dry_run)

    channel_cache = cache.channel_cache(channel)

    def sync_crash(r):
        accid = r.name
        crash = Crash(accid)
        xml_url = crash.xml_url(ref=commit)
        new_text = crash_str(r, xml_url=xml_url)
        msg = cache.accid_to_msg.get(accid)
        if not msg:
            cached_msg = channel_cache.get(accid)
            if cached_msg:
                msg = cached_msg
                err(f"ACCID {accid}: using cached msg {msg['ts']}")

        msg_kwargs = dict(
            channel=channel,
            text=new_text,
            unfurl_links=False,
            unfurl_media=False,
            metadata={
                'event_type': 'new_crash',
                'event_payload': { 'ACCID': accid, },
            },
        )

        def post_message():
            m = '\n\t'.join([
                f"ACCID {accid} posting new message:",
                *[
                    f'{k}={v}'
                    for k, v in msg_kwargs.items()
                ]
            ])
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                resp = client.client.chat_postMessage(**msg_kwargs)
                msg = resp.data['message']
                err(f"ACCID {accid}: sent message {msg['ts']}")
                cache.update(msg)

        if msg:
            text = msg['text']
            ts = msg['ts']
            if overwrite_existing > 1:
                m = f"ACCID {accid} deleting"
                if dry_run:
                    err(f"DRY RUN {m}")
                else:
                    err(m)
                    client.client.chat_delete(channel=channel, ts=ts)
                    if accid in channel_cache:
                        del channel_cache[accid]
                        cache.accid2msg_cache_updated = True
                post_message()
            elif new_text != text or overwrite_existing:
                update_kwargs = dict(**msg_kwargs, ts=ts)
                if new_text != text:
                    m = f"ACCID {accid} text doesn't match:\n-{text}\n+{new_text}"
                else:
                    m = f"ACCID {accid} overwriting message: {text}"
                if dry_run:
                    err(f"DRY RUN {m}")
                else:
                    err(m)
                    resp = client.client.chat_update(**update_kwargs)
                    data = resp.data
                    new_msg = data['message']
                    new_ts = data['ts']
                    if ts != new_ts:
                        raise RuntimeError(f"Message {ts} updated to {new_ts}")
                    new_msg['ts'] = ts  # Not included in chat.update `message` payload
                    cache.update(channel, new_msg)
            else:
                err(f"ACCID {accid} text matches: {text}")
        else:
            post_message()

    crashes.apply(sync_crash, axis=1)
    cache.close()
