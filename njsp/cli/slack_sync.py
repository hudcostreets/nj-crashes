import json
from os import makedirs
from os.path import exists, dirname
from typing import Union, Callable, Optional

import pandas as pd
from click import option
from pandas import isna
from slack_sdk import WebClient
from utz import env, err
from utz.ymd import dates, YMD

from njsp.cli.base import njsp

VICTIM_TYPES = {
    'D': 'driver',
    'P': 'passenger',
    'T': 'pedestrian',
    'B': 'cyclist',
}


def crash_str(r: pd.Series, fmt: Union[Callable, str] = '%a %b %-d %Y %-I:%M%p') -> str:
    victim_pcs = []
    for suffix, name in VICTIM_TYPES.items():
        num = r[f'FATAL_{suffix}']
        if not isna(num) and num > 0:
            num = int(num)
            noun = name if num == 1 else f'{name}s'
            victim_pcs.append(f'{num} {noun}')

    victim_str = ', '.join(victim_pcs)
    dt = r['dt']
    if callable(fmt):
        dt_str = fmt(dt)
    else:
        dt_str = dt.strftime(fmt)
    return f'*{dt_str} (ID {r.name})*: {r.MNAME} ({r.CNAME} County), {r.LOCATION}: {victim_str} deceased'


@njsp.command('slack_sync')
@dates(default_start=YMD(2008))
@option('-m', '--fetch-messages', type=int)
@option('-n', '--dry-run', count=True)
def slack_sync(start: YMD, end: YMD, fetch_messages: Optional[int], dry_run: int):
    # print(f'{start=}, {end=}')
    crashes = pd.read_parquet('data/crashes.pqt')
    crashes = crashes[crashes.dt.dt.date >= start.date]
    if end:
        crashes = crashes[crashes.dt.dt.date < end.date]
    err(f"{len(crashes)} crashes:")
    err(str(crashes))

    channel = 'C05JZ0C5LEL'  # #crash-bot
    slack_config_dir = '.slack'
    token = env.get('SLACK_BOT_TOKEN')
    if not token:
        slack_token_path = f'{slack_config_dir}/token'
        if exists(slack_token_path):
            with open(slack_token_path, 'r') as f:
                token = f.read()
        else:
            raise RuntimeError(f"No $SLACK_BOT_TOKEN or {slack_token_path} found")

    accid2msg_cache_path = f'{slack_config_dir}/accid2msg.json'
    accid2msg_cache = {}
    accid2msg_cache_updated = False
    if exists(accid2msg_cache_path):
        with open(accid2msg_cache_path, 'r') as f:
            accid2msg_cache = json.load(f)
        err(f"Loaded accid2msg cache ({len(accid2msg_cache)} entries)")

    client = WebClient(token=token)

    accid_to_msg = {}

    if fetch_messages:
        msg = f"Slack: fetching {fetch_messages} messages"
        if dry_run:
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
                    cached_msg = accid2msg_cache.get(accid)
                    if not cached_msg:
                        err(f"ACCID {accid}: new cached msg {msg}")
                        accid2msg_cache[accid] = msg
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
                        accid2msg_cache[accid] = msg
                        accid2msg_cache_updated = True

    def sync_crash(r):
        new_text = crash_str(r)
        accid = r.name
        msg = accid_to_msg.get(accid)
        if not msg:
            cached_msg = accid2msg_cache.get(accid)
            if cached_msg:
                msg = cached_msg
                err(f"ACCID {accid}: using cached msg {msg['ts']}")

        def msg_kwargs(event_type: str, **kwargs):
            return dict(
                channel=channel,
                text=new_text,
                metadata={
                    'event_type': event_type,
                    'event_payload': { 'ACCID': accid, },
                },
                **kwargs,
            )
        if msg:
            text = msg['text']
            if new_text != text:
                update_kwargs = msg_kwargs('updated_crash', ts=msg['ts'])
                msg = f"ACCID {accid} text doesn't match: \"{text}\" != \"{new_text}\""
                if dry_run:
                    err(f"DRY RUN {msg}")
                else:
                    err(msg)
                    resp = client.chat_update(**update_kwargs)
                    # err(str(resp.data))
            else:
                err(f"ACCID {accid} text matches: {text}")
        else:
            msg = f"ACCID {accid}: posting new message"
            if dry_run:
                err(f"DRY RUN {msg}")
            else:
                err(msg)
                post_kwargs = msg_kwargs('new_crash')
                resp = client.chat_postMessage(**post_kwargs)
                msg = resp.data['message']
                accid2msg_cache[accid] = msg
                nonlocal accid2msg_cache_updated
                accid2msg_cache_updated = True
                err(f"ACCID {accid}: sent message {msg['ts']}")

    crashes.apply(sync_crash, axis=1)

    if accid2msg_cache_updated:
        err(f"Dumping updated ts_hints ({len(accid2msg_cache)} entries) to {accid2msg_cache_path}")
        makedirs(dirname(accid2msg_cache_path), exist_ok=True)
        with open(accid2msg_cache_path, 'w') as f:
            json.dump(accid2msg_cache, f, indent=4)
