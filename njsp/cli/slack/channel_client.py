import json
from datetime import datetime
from functools import cache
from os import makedirs, environ
from os.path import exists
from typing import Optional, Iterable, Callable

from pandas import Series, DataFrame
from slack_sdk import WebClient
from stdlb import fromtimestamp
from utz import cached_property, err, singleton, Log, silent, solo

from njsp.cli.slack.config import SLACK_CHANNEL_ID, SLACK_CONFIG_DIR, SLACK_BOT_TOKEN
from njsp.cli.slack.msg import Reply, Thread

CHANNEL_OPTS = ('-h', '--channel')


def resolve_channel(
    channel: str | None,
    client: 'ChannelClient',
) -> str:
    client = client.client
    channel = load_slack_config(
        env=SLACK_CHANNEL_ID,
        basename='channel',
        value=channel,
        opts=CHANNEL_OPTS,
    )
    err(f"Loaded channel: {channel}")
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


DEFAULT_BATCH_SIZE = 1_000
DEFAULT_MAX_MSGS = 10_000


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
    value: str | None = None,
    opts: Iterable[str] | None = None,
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
    def __init__(self, channel: str, dry_run: bool = False):
        self.channel = resolve_channel(channel, client=self)
        self.dry_run = dry_run

    @cached_property
    def token(self):
        return load_slack_config(env=SLACK_BOT_TOKEN, basename='token')

    @cached_property
    def client(self):
        return WebClient(token=self.token)

    @staticmethod
    def fetch(
        mth,
        rec_key: str,
        index: str | None = None,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int = DEFAULT_MAX_MSGS,
        log: Log = err,
        **kwargs,
    ) -> DataFrame:
        log = log or silent
        recs = []
        cursor = None
        while True:
            limit = min(max_recs - len(recs), batch_size) if max_recs else batch_size
            if limit < 0:
                raise RuntimeError(f"{max_recs=} < {len(recs)=}, can't fetch more")
            elif limit == 0:
                break
            res = mth(limit=limit, cursor=cursor, **kwargs)
            data = res.data
            batch = data.pop(rec_key, [])
            assert res.status_code == 200, f"Slack API error: {res.status_code} ({data.get('error')}"
            log(f"Slack: fetched batch of {len(batch)} {rec_key}")
            recs += batch
            cursor = data.get('response_metadata', {}).get('next_cursor')
            if not cursor:
                break
        df = DataFrame(recs)
        if index:
            df = df.set_index(index, verify_integrity=True)
        return df

    @cache
    def users(self, **kwargs):
        return self.fetch(
            mth=self.client.users_list,
            rec_key='members',
            index='id',
            **kwargs,
        )

    @cached_property
    def crash_bot_uid(self) -> str:
        users = self.users()
        return solo(users[users.is_bot & (users.name == 'crash_bot')].index.tolist())

    @cached_property
    def roots_msk(self) -> Series:
        msgs = self.msgs()
        return msgs.thread_ts.isna() | (msgs.thread_ts == msgs.index.to_series())

    @cached_property
    def accid_msgs(self) -> Series:
        root_msgs = self.root_msgs
        uid = self.crash_bot_uid
        root_bot_msgs = (
            root_msgs
            [root_msgs.user == uid]
            .metadata
            .apply(Series)
            [['event_type', 'event_payload']]
        )
        accid_msgs = root_bot_msgs[root_bot_msgs.event_type == 'new_crash'].drop(columns='event_type')
        accid_msgs['ACCID'] = accid_msgs.event_payload.apply(Series)['ACCID']
        accid_msgs = accid_msgs.drop(columns='event_payload').ACCID
        return accid_msgs

    @cached_property
    def ts2accid(self) -> dict[str, int]:
        return self.accid_msgs.to_dict()

    @cached_property
    def accid_dups(self) -> DataFrame:
        accid_msgs = self.accid_msgs
        h = accid_msgs.value_counts()
        multis = h[h > 1]
        return (
            accid_msgs
            [accid_msgs.isin(multis.index)]
            .reset_index()
            .sort_values(['ACCID', 'ts'])
        )

    def accid_dups_to_remove(self) -> DataFrame:
        return (
            self.accid_dups
            .groupby('ACCID')
            .apply(
                lambda df: (
                    df
                    .assign(dt=df.ts.astype(float).apply(fromtimestamp))
                    .sort_values('dt')
                    .iloc[1:]
                )
            )
            .set_index('ts')[['ACCID']]
            .merge(
                self.msgs()[['dt', 'text']],
                how='left',
                left_index=True,
                right_index=True,
            )
        )

    def verify_accids(self):
        assert self.accid_dups.empty

    def accid_thread(self, accid: int) -> Thread:
        accid2ts = self.accid2ts
        ts = accid2ts[accid]
        msgs = self.msgs()
        msg = msgs.loc[ts]
        thread_ts = msg.thread_ts
        if thread_ts != ts:
            raise ValueError(f"ACCID {accid}: {ts=} != {thread_ts=}")
        replies_df = msgs[(msgs.thread_ts == thread_ts)].reset_index()
        replies_df = replies_df[replies_df.ts != ts]
        replies = [
            Reply(**rec)
            for rec in replies_df.to_dict('records')
        ]
        return Thread(ts=ts, text=msg.text, replies=replies)

    @cached_property
    def accid2ts(self) -> dict[int, str]:
        self.verify_accids()
        return { v: k for k, v in self.ts2accid.items() }

    @cached_property
    def root_msgs(self) -> DataFrame:
        msgs = self.msgs()
        return msgs[self.roots_msk]

    @cached_property
    def replies(self) -> DataFrame:
        msgs = self.msgs()
        return msgs[~self.roots_msk]

    @cache
    def msgs(self, include_all_metadata: bool = True, **kwargs):
        df = self.fetch(
            mth=self.client.conversations_history,
            rec_key='messages',
            index='ts',
            channel=self.channel,
            include_all_metadata=include_all_metadata,
            **kwargs,
        )
        df['dt'] = df.index.to_series().astype(float).apply(datetime.fromtimestamp)
        return df

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

    def delete_msg(self, ts: str):
        self.client.chat_delete(channel=self.channel, ts=ts)

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
