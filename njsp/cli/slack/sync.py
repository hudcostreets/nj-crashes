import json
from os import makedirs, environ
from os.path import exists, dirname
from typing import Optional, Iterable, Callable

import pandas as pd
from click import option
from slack_sdk import WebClient
from utz import err, singleton
from utz.ymd import dates, YMD

from .base import slack
from ...commit_crashes import crash_str, CommitCrashes
from ...crash import Crash

SLACK_CHANNEL_ID = 'SLACK_CHANNEL_ID'
SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN'
SLACK_CONFIG_DIR = '.slack'


channel_opts = ('-h', '--channel')


def channel_by_name(client: WebClient, name: str) -> str:
    resp = client.conversations_list()
    channels = resp.data['channels']
    if name.startswith('#'):
        name = name[1:]
    channel = singleton([ c['id'] for c in channels if c['name'] == name ])
    return channel


def cached_fetch(basename: str, key: str, method: Callable, **kwargs):
    def fetch(client: WebClient, cache_read: bool = True, cache_write: bool = True, **extra_kwargs) -> dict:
        cache_path = f'{SLACK_CONFIG_DIR}/{basename}'
        if exists(cache_path) and cache_read:
            with open(cache_path, 'r') as f:
                return json.load(f)
        resp = method(client, **kwargs, **extra_kwargs)
        users = resp.data[key]
        if cache_write:
            makedirs(SLACK_CONFIG_DIR, exist_ok=True)
            with open(cache_path, 'w') as f:
                json.dump(users, f, indent=2)
        return users

    return fetch


fetch_users = cached_fetch('members.json', 'members', WebClient.users_list)
fetch_ims = cached_fetch('ims.json', 'channels', WebClient.conversations_list, types=['im'])


def user_by_name(client: WebClient, name: str, **kwargs) -> dict:
    users = fetch_users(client, **kwargs)
    if name.startswith('@'):
        name = name[1:]
    user = singleton([ u for u in users if u['profile']['display_name'] == name ], dedupe=False, empty_ok=True)
    if user:
        return user
    user = singleton([ u for u in users if u['real_name'] == name ], dedupe=False, empty_ok=True)
    if user:
        return user
    user = singleton([ u for u in users if name in u['profile']['display_name'] ], dedupe=False, empty_ok=True)
    if user:
        return user
    user = singleton([ u for u in users if name in u['real_name'] ], dedupe=False, empty_ok=True)
    if user:
        return user

    raise ValueError(f"No user found with \"display_name\" or \"real_name\" matching \"{name}\"")


def im_channel(client: WebClient, user_id: str, **kwargs) -> Optional[dict]:
    ims = fetch_ims(client, **kwargs)
    return singleton([ c for c in ims if c['user'] == user_id ], dedupe=False, empty_ok=True)


@slack.command('sync')
@option('-c', '--commit', 'commits', multiple=True, help='Commits to parse new crashes from')
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-f', '--overwrite-existing', count=True, help='1x')
@option(*channel_opts, help='Slack channel ID to post to; defaults to $SLACK_CHANNEL_ID')
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

    def load_slack_config(env: str, basename: str, value: Optional[str] = None, opts: Optional[Iterable[str]] = None) -> str:
        if value:
            return value
        value = environ.get(SLACK_CHANNEL_ID)
        if value:
            return value

        path = f'{SLACK_CONFIG_DIR}/{basename}'
        if exists(path):
            with open(path, 'r') as f:
                return f.read()
        else:
            candidates = [
                *('/'.join(opts) if opts else []),
                f'${env}',
                path,
            ]
            if len(candidates) == 1:
                candidates_str = candidates
            elif len(candidates) == 2:
                candidates_str = ' or '.join(candidates)
            else:
                [ *prefix, last ] = candidates
                candidates_str = ', '.join([ *prefix, f'or {last}'])
            raise RuntimeError(f"No {candidates_str} found")

    token = load_slack_config(env=SLACK_BOT_TOKEN, basename='token')
    client = WebClient(token=token)

    channel = load_slack_config(env=SLACK_CHANNEL_ID, basename='channel', value=channel, opts=channel_opts)
    if channel.startswith('#'):
        channel = channel_by_name(client, channel)
        err(f'Looked up channel ID: {channel}')
    elif channel.startswith('@'):
        user = user_by_name(client, channel)
        user_id = user['id']
        channel = im_channel(client, user_id=user_id)['id']
        err(f"Looked up IM channel {channel} for user {user_id}")

    accid2msg_cache_path = f'{SLACK_CONFIG_DIR}/accid2msg.json'
    accid2msg_cache = {}
    accid2msg_cache_updated = False
    if exists(accid2msg_cache_path):
        with open(accid2msg_cache_path, 'r') as f:
            accid2msg_cache = json.load(f)
            err(f"Loaded accid2msg cache ({len(accid2msg_cache)} entries)")

    if channel not in accid2msg_cache:
        accid2msg_cache[channel] = {}
    channel_cache = accid2msg_cache[channel]

    accid_to_msg = {}

    if fetch_messages:
        msg = f"Slack: fetching {fetch_messages} messages"
        if dry_run > 1:
            err(f"DRY RUN {msg}")
        else:
            err(msg)
            resp = client.conversations_history(channel=channel, include_all_metadata=True, limit=fetch_messages)
            msgs = resp.data['messages']
            err(f'Slack: fetched {len(msgs)} messages')
            for msg in msgs:
                accid = msg.get('metadata', {}).get('event_payload', {}).get('ACCID')
                if 'blocks' in msg:
                    del msg['blocks']  # Each block's `block_id` field seems to change spuriously / with each fetch
                if accid:
                    accid_to_msg[accid] = msg
                    cached_msg = channel_cache.get(accid)
                    if not cached_msg:
                        err(f"ACCID {accid}: caching msg")
                        channel_cache[accid] = msg
                        accid2msg_cache_updated = True
                    elif msg != cached_msg:
                        err(f"ACCID {accid}: updating cached msg:")
                        try:
                            from deepdiff import DeepDiff
                            from pprint import pprint
                            pprint(DeepDiff(cached_msg, msg), indent=2)
                        except ImportError:
                            for k, v0 in cached_msg.items():
                                if k in msg:
                                    v1 = msg[k]
                                    if v0 != v1:
                                        err(f"\t{k}: {v0} -> {v1}")
                                else:
                                    err(f"\t{k} deleted: {v0}")
                            for k, v1 in msg.items():
                                if k not in cached_msg:
                                    err(f"\t{k} added: {v1}")
                        channel_cache[accid] = msg
                        accid2msg_cache_updated = True

    def sync_crash(r):
        nonlocal accid2msg_cache_updated
        accid = r.name
        crash = Crash(accid)
        xml_url = crash.xml_url(ref=commit)
        new_text = crash_str(r, xml_url=xml_url)
        msg = accid_to_msg.get(accid)
        if not msg:
            cached_msg = channel_cache.get(accid)
            if cached_msg:
                msg = cached_msg
                err(f"ACCID {accid}: using cached msg {msg['ts']}")

        def msg_kwargs(event_type: str, **kwargs):
            return dict(
                channel=channel,
                text=new_text,
                unfurl_links=False,
                unfurl_media=False,
                metadata={
                    'event_type': event_type,
                    'event_payload': { 'ACCID': accid, },
                },
                **kwargs,
            )

        def post_message():
            nonlocal accid2msg_cache_updated
            post_kwargs = msg_kwargs('new_crash')
            m = '\n\t'.join([
                f"ACCID {accid} posting new message:",
                *[
                    f'{k}={v}'
                    for k, v in post_kwargs.items()
                ]
            ])
            if dry_run:
                err(f"DRY RUN {m}")
            else:
                err(m)
                resp = client.chat_postMessage(**post_kwargs)
                msg = resp.data['message']
                channel_cache[accid] = msg
                accid2msg_cache_updated = True
                err(f"ACCID {accid}: sent message {msg['ts']}")

        if msg:
            text = msg['text']
            ts = msg['ts']
            if overwrite_existing > 1:
                m = f"ACCID {accid} deleting"
                if dry_run:
                    err(f"DRY RUN {m}")
                else:
                    err(m)
                    client.chat_delete(channel=channel, ts=ts)
                    if accid in channel_cache:
                        del channel_cache[accid]
                        accid2msg_cache_updated = True
                post_message()
            elif new_text != text or overwrite_existing:
                update_kwargs = msg_kwargs('updated_crash', ts=ts)
                if new_text != text:
                    m = f"ACCID {accid} text doesn't match:\n-{text}\n+{new_text}"
                else:
                    m = f"ACCID {accid} overwriting message: {text}"
                if dry_run:
                    err(f"DRY RUN {m}")
                else:
                    err(m)
                    client.chat_update(**update_kwargs)
            else:
                err(f"ACCID {accid} text matches: {text}")
        else:
            post_message()

    crashes.apply(sync_crash, axis=1)

    if accid2msg_cache_updated:
        err(f"Dumping updated ts_hints ({len(accid2msg_cache)} entries) to {accid2msg_cache_path}")
        makedirs(dirname(accid2msg_cache_path), exist_ok=True)
        with open(accid2msg_cache_path, 'w') as f:
            json.dump(accid2msg_cache, f, indent=4)
