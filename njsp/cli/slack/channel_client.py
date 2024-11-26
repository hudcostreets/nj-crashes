import json
from os import makedirs, environ
from os.path import exists
from typing import Optional, Iterable, Callable

from slack_sdk import WebClient
from utz import cached_property, err, singleton

from njsp.cli.slack.channel_cache import ChannelCache
from njsp.cli.slack.config import SLACK_CHANNEL_ID, SLACK_CONFIG_DIR, SLACK_BOT_TOKEN

CHANNEL_OPTS = ('-h', '--channel')


def resolve_channel(channel: Optional[str], client: 'ChannelClient') -> str:
    client = client.client
    channel = load_slack_config(env=SLACK_CHANNEL_ID, basename='channel', value=channel, opts=CHANNEL_OPTS)
    print("loaded channel", channel)
    if channel.startswith('#'):
        channel = channel_by_name(client, channel)
        err(f'Looked up channel ID: {channel}')
    elif channel.startswith('@'):
        user = user_by_name(client, channel)
        user_id = user['id']
        channel = im_channel(client, user_id=user_id)['id']
        err(f"Looked up IM channel {channel} for user {user_id}")
    # else:
    #     raise ValueError("Expected #<channel> or @<user> for channel")
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


def channel_by_name(client: WebClient, name: str) -> str:
    resp = client.conversations_list()
    channels = resp.data['channels']
    if name.startswith('#'):
        name = name[1:]
    channel = singleton([ c['id'] for c in channels if c['name'] == name ])
    return channel


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


def load_slack_config(
    env: str,
    basename: str,
    value: Optional[str] = None,
    opts: Optional[Iterable[str]] = None,
) -> str:
    if value:
        return value
    value = environ.get(env)
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


class ChannelClient:
    def __init__(self, channel: str, dry_run: int = 0):
        self.channel = resolve_channel(channel, client=self)
        self.dry_run = dry_run

    @cached_property
    def cache(self) -> ChannelCache:
        return ChannelCache(channel=self.channel)

    @cached_property
    def token(self):
        return load_slack_config(env=SLACK_BOT_TOKEN, basename='token')

    @cached_property
    def client(self):
        return WebClient(token=self.token)

    def fetch_messages(self, limit: int = 1000):
        msg = f"Slack: fetching {limit} messages"
        if self.dry_run > 1:
            err(f"DRY RUN {msg}")
        else:
            err(msg)
            resp = self.client.conversations_history(channel=self.channel, include_all_metadata=True, limit=limit)
            msgs = resp.data['messages']
            err(f'Slack: fetched {len(msgs)} messages')
            for msg in msgs:
                self.cache.update(msg)

    def msg_kwargs(self, accid: str, text: str) -> dict:
        return dict(
            channel=self.channel,
            text=text,
            unfurl_links=False,
            unfurl_media=False,
            metadata={
                'event_type': 'new_crash',
                'event_payload': { 'ACCID': accid, },
            },
        )

    def post_msg(self, accid: str, text: str):
        msg_kwargs = self.msg_kwargs(accid=accid, text=text)
        m = '\n\t'.join([
            f"ACCID {accid} posting new message:",
            *[
                f'{k}={v}'
                for k, v in msg_kwargs.items()
            ]
        ])
        if self.dry_run:
            err(f"DRY RUN {m}")
        else:
            err(m)
            resp = self.client.chat_postMessage(**msg_kwargs)
            msg = resp.data['message']
            err(f"ACCID {accid}: sent message {msg['ts']}")
            self.cache.update(msg)

    def delete_msg(self, ts: str, accid: str):
        self.client.chat_delete(channel=self.channel, ts=ts)
        self.cache.delete_msg(accid)

    def update_msg(self, ts: str, accid: str, text: str):
        update_kwargs = dict(
            **self.msg_kwargs(accid=accid, text=text),
            ts=ts,
        )
        resp = self.client.chat_update(**update_kwargs)
        data = resp.data
        new_msg = data['message']
        new_ts = data['ts']
        if ts != new_ts:
            raise RuntimeError(f"Message {ts} updated to {new_ts}")
        new_msg['ts'] = ts  # Not included in chat.update `message` payload
        self.cache.update(new_msg)
