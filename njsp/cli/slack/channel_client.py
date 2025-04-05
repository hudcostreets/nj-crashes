from datetime import datetime
from functools import cache
from os.path import exists, join

from dotenv import dotenv_values
from pandas import Series, DataFrame, isna
from slack_sdk import WebClient
from stdlb import fromtimestamp
from utz import cached_property, err, singleton, silent, solo, env, call

from njsp.cli.slack.config import SLACK_CHANNEL_ID, SLACK_BOT_TOKEN
from njsp.cli.slack.msg import Msg, Thread
from ...crash import Log, Add, Update
from ...utils import RED, GREEN, RESET, BLUE

CHANNEL_OPTS = ('-h', '--channel')


DEFAULT_BATCH_SIZE = 1_000
DEFAULT_MAX_RECS = 10_000


class ChannelClient:
    def __init__(
        self,
        channel: str | None = None,
        dry_run: bool = False,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int = DEFAULT_MAX_RECS,
    ):
        if not channel:
            channel = env.get(SLACK_CHANNEL_ID)
        token = env.get(SLACK_BOT_TOKEN)
        env_path = join('.slack', '.env')
        if not channel or not token:
            if exists(env_path):
                config = dotenv_values(env_path)
                if not channel:
                    channel = config.get(SLACK_CHANNEL_ID)
                if not token:
                    token = config.get(SLACK_BOT_TOKEN)
        if not channel:
            raise RuntimeError(f"Missing {SLACK_CHANNEL_ID} in environment and {env_path}, and no {'/'.join(CHANNEL_OPTS)} passed")
        if not token:
            raise RuntimeError(f"Missing {SLACK_BOT_TOKEN} in environment and {env_path}")

        client = WebClient(token=token)
        err(f"Resolving channel: {channel}")
        if channel.startswith('#'):
            channel = self.channel_by_name(channel)
            err(f'Looked up channel ID: {channel}')
        elif channel.startswith('@'):
            user = self.user_by_name(channel)
            user_id = user['id']
            channel = self.im_channel(user_id=user_id)['id']
            err(f"Looked up IM channel {channel} for user {user_id}")

        self.channel = channel
        self.token = token
        self.dry_run = dry_run
        self.client = client
        self.batch_size = batch_size
        self.max_recs = max_recs

    def fetch(
        self,
        mth,
        rec_key: str,
        index: str | None = None,
        batch_size: int | None = None,
        max_recs: int | None = None,
        log: Log = err,
        **kwargs,
    ) -> DataFrame:
        log = log or silent
        recs = []
        cursor = None
        if batch_size is None:
            batch_size = self.batch_size
        if max_recs is None:
            max_recs = self.max_recs
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

    def user_by_name(self, name: str, **kwargs) -> dict:
        users = self.users(**kwargs)
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

    @cache
    def conversations(self, **kwargs):
        return self.fetch(
            mth=self.client.conversations_list,
            rec_key='channels',
            index='id',
            **kwargs,
        )

    def channel_by_name(self, name: str) -> str:
        channels = self.conversations()
        if name.startswith('#'):
            name = name[1:]
        return solo([ c['id'] for c in channels if c['name'] == name ])

    def im_channel(self, user_id: str, **kwargs: str | int) -> dict | None:
        ims = self.conversations(types=('im',), **kwargs)
        return singleton([ c for c in ims if c['user'] == user_id ], dedupe=False, empty_ok=True)

    @cached_property
    def crash_bot_uid(self) -> str:
        users = self.users()
        return solo(users[users.is_bot & (users.name == 'crash_bot')].index.tolist())

    @cached_property
    def accid_msgs(self) -> Series:
        msgs = self.msgs()
        uid = self.crash_bot_uid
        bot_msgs = (
            msgs
            [msgs.user == uid]
            .metadata
            .apply(Series)
            [['event_type', 'event_payload']]
        )
        accid_msgs = bot_msgs[bot_msgs.event_type == 'new_crash'].drop(columns='event_type')
        accid_msgs['ACCID'] = accid_msgs.event_payload.apply(Series)['ACCID']
        accid_msgs = accid_msgs.drop(columns='event_payload').ACCID.astype(int)
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

    @cached_property
    def accid2ts(self) -> dict[int, str]:
        self.verify_accids()
        return { v: k for k, v in self.ts2accid.items() }

    def accid_thread(self, accid: int) -> Thread | None:
        accid2ts = self.accid2ts
        if accid not in accid2ts:
            return None
        ts = accid2ts[accid]
        msgs = self.msgs()
        msg = msgs.loc[ts]
        thread_ts = msg.thread_ts
        if isna(thread_ts):
            replies = []
        else:
            if ts != thread_ts:
                raise ValueError(f"{ts=} != {thread_ts=}")
            replies_df = self.fetch(
                self.client.conversations_replies,
                'messages',
                channel=self.channel,
                ts=ts,
                index='ts',
                include_all_metadata=True,
            )
            uid = self.crash_bot_uid
            replies_df = replies_df.drop(ts)
            replies_df = replies_df[replies_df.user == uid]
            reply_accids = replies_df.metadata.apply(Series).event_payload.apply(Series).ACCID.astype(int)
            wrong_accid_msk = reply_accids != accid
            if wrong_accid_msk.any():
                raise ValueError(f"Thread {thread_ts} has replies from {uid} for other ACCIDs: {replies_df[wrong_accid_msk.index]}")

            replies = [
                call(Msg, **rec)
                for rec in replies_df.reset_index().to_dict('records')
            ]
        return Thread(ts=ts, text=msg.text, replies=replies)

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

    def msg_kwargs(
        self,
        accid: int,
        text: str,
        event_type: str,
        thread_ts: str | None = None,
    ) -> dict:
        return dict(
            channel=self.channel,
            text=text,
            unfurl_links=False,
            unfurl_media=False,
            thread_ts=thread_ts,
            metadata={
                'event_type': event_type,
                'event_payload': { 'ACCID': str(accid), },
            },
        )

    def post_msg(
        self,
        accid: int,
        text: str,
        event_type: str,
        thread_ts: str | None = None,
    ) -> str:
        msg_kwargs = self.msg_kwargs(accid=accid, text=text, event_type=event_type, thread_ts=thread_ts)
        m = '\n\t'.join([
            f"ACCID {accid} posting new message:",
            *[
                f'{k}={v}'
                for k, v in msg_kwargs.items()
            ]
        ])
        if self.dry_run:
            err(f"DRY RUN {m}")
            return 'xxx'
        else:
            err(m)
            resp = self.client.chat_postMessage(**msg_kwargs)
            msg = resp.data['message']
            ts = msg['ts']
            err(f"ACCID {accid}: sent message {ts}")
            return ts

    def delete_msg(self, ts: str):
        self.client.chat_delete(channel=self.channel, ts=ts)

    def update_msg(
        self,
        ts: str,
        accid: int,
        text: str,
        event_type: str,
    ):
        update_kwargs = dict(
            **self.msg_kwargs(accid=accid, text=text, event_type=event_type),
            ts=ts,
        )
        resp = self.client.chat_update(**update_kwargs)
        data = resp.data
        new_msg = data['message']
        new_ts = data['ts']
        if ts != new_ts:
            raise RuntimeError(f"Message {ts} updated to {new_ts}")
        new_msg['ts'] = ts  # Not included in chat.update `message` payload

    def sync_crash(
        self,
        accid: int,
        crash_log: Log,
        overwrite_existing: int = 0,
        dry_run: int | None = None,
    ) -> None:
        if dry_run is None:
            dry_run = self.dry_run
        thread = self.accid_thread(accid)
        if thread:
            msgs = thread.msgs
            thread_ts = thread.ts
        else:
            msgs = []
            thread_ts = None

        def log(msg: str):
            if dry_run:
                msg = f"DRY RUN {msg}"
            err(f"{BLUE}{accid:>5d}: {msg}{RESET}")

        for i, v in enumerate(crash_log.versions):
            xml_url = v.xml_url(ref=v.sha)
            if isinstance(v, (Add, Update)):
                new_text = v.to_str(github_url=xml_url)
            else:
                prev = crash_log.versions[i - 1]
                if isinstance(prev, (Add, Update)):
                    new_text = f"Deleted: {prev.to_str(github_url=xml_url)}"
                else:
                    raise ValueError(f"Invalid version sequence ({i=}): {prev=} → {v=}")

            event_type = "new_crash" if i == 0 else "update_crash"
            tts = thread_ts
            if i > 0 and not tts:
                raise RuntimeError(f"Missing thread_ts for update {i} of {accid}")

            update_kwargs = dict(accid=accid, text=new_text, event_type=event_type)
            post_kwargs = dict(**update_kwargs, thread_ts=tts)
            if i < len(msgs):
                msg = msgs[i]
                text = msg.text
                ts = msg.ts
                if overwrite_existing > 1:
                    log("deleting")
                    if not dry_run:
                        self.delete_msg(ts=ts)
                    ts = self.post_msg(**post_kwargs)
                    if not thread_ts:
                        thread_ts = ts
                elif new_text != text or overwrite_existing:
                    if new_text != text:
                        m = f"text doesn't match:\n{RED}-{text}\n{GREEN}+{new_text}"
                    else:
                        m = f"overwriting message: {text}"
                    log(m)
                    if not dry_run:
                        self.update_msg(ts=ts, **update_kwargs)
                else:
                    log(f"text matches: {text}")
            else:
                ts = self.post_msg(**post_kwargs)
                if not thread_ts:
                    thread_ts = ts
