import json
from os import makedirs, environ
from os.path import exists, dirname
from typing import Optional, Iterable, Callable

from slack_sdk import WebClient
from utz import cached_property, err, singleton

SLACK_CHANNEL_ID = 'SLACK_CHANNEL_ID'
SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN'
SLACK_CONFIG_DIR = '.slack'


CHANNEL_OPTS = ('-h', '--channel')


def resolve_channel(channel: Optional[str], client: 'Client') -> str:
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


SKIP_CACHE_KEYS = [ 'blocks', 'edited' ]


class MsgCache:
    def __init__(self, client: WebClient):
        self.client = client
        self.accid2msg_cache_updated = False
        self.accid_to_msg = {}

    @property
    def accid2msg_cache_path(self):
        return f'{SLACK_CONFIG_DIR}/accid2msg.json'

    @cached_property
    def accid2msg_cache(self):
        accid2msg_cache = {}
        if exists(self.accid2msg_cache_path):
            with open(self.accid2msg_cache_path, 'r') as f:
                accid2msg_cache = json.load(f)
                err(f"Loaded accid2msg cache ({len(accid2msg_cache)} entries)")
        return accid2msg_cache

    def channel_cache(self, channel):
        accid2msg_cache = self.accid2msg_cache
        if channel not in accid2msg_cache:
            accid2msg_cache[channel] = {}
        return accid2msg_cache[channel]

    def update(self, channel, msg):
        accid = msg.get('metadata', {}).get('event_payload', {}).get('ACCID')
        if not accid:
            return
        msg = {
            k: v
            for k, v in msg.items()
            if k not in SKIP_CACHE_KEYS
        }
        accid_to_msg = self.accid_to_msg
        accid_to_msg[accid] = msg
        channel_cache = self.channel_cache(channel)
        cached_msg = channel_cache.get(accid)
        if not cached_msg:
            err(f"ACCID {accid}: caching msg")
            channel_cache[accid] = msg
            self.accid2msg_cache_updated = True
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
            self.accid2msg_cache_updated = True

    def fetch_messages(self, channel: str, limit: int = 1000, dry_run: int = 0):
        msg = f"Slack: fetching {limit} messages"
        if dry_run > 1:
            err(f"DRY RUN {msg}")
        else:
            err(msg)
            resp = self.client.conversations_history(channel=channel, include_all_metadata=True, limit=limit)
            msgs = resp.data['messages']
            err(f'Slack: fetched {len(msgs)} messages')
            for msg in msgs:
                self.update(channel, msg)

    def close(self):
        if self.accid2msg_cache_updated:
            accid2msg_cache = self.accid2msg_cache
            accid2msg_cache_path = self.accid2msg_cache_path
            err(f"Dumping updated ts_hints ({len(accid2msg_cache)} entries) to {accid2msg_cache_path}")
            makedirs(dirname(accid2msg_cache_path), exist_ok=True)
            with open(accid2msg_cache_path, 'w') as f:
                json.dump(accid2msg_cache, f, indent=4)


class Client:
    @cached_property
    def cache(self):
        return MsgCache(self.client)

    @cached_property
    def token(self):
        return load_slack_config(env=SLACK_BOT_TOKEN, basename='token')

    @cached_property
    def client(self):
        return WebClient(token=self.token)

    def fetch_messages(self, limit: int = 1000, channel: Optional[str] = None, dry_run: int = 0):
        channel = resolve_channel(channel, client=self)
        self.cache.fetch_messages(channel=channel, limit=limit, dry_run=dry_run)


