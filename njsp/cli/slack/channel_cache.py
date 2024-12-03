from os import makedirs
from os.path import exists, dirname

import json
from utz import cached_property, err

from njsp.cli.slack.config import SLACK_CONFIG_DIR

SKIP_CACHE_KEYS = [ 'blocks', 'edited' ]


class ChannelCache:
    def __init__(self, channel: str):
        self.channel = channel
        self.accid2msg_cache_updated = False
        self.accid_to_msg = {}

    @property
    def accid2msg_cache_path(self):
        return f'{SLACK_CONFIG_DIR}/accid2msg.json'

    @cached_property
    def channels_cache(self):
        accid2msg_cache = {}
        if exists(self.accid2msg_cache_path):
            with open(self.accid2msg_cache_path, 'r') as f:
                accid2msg_cache = json.load(f)
                err(f"Loaded accid2msg cache ({len(accid2msg_cache)} entries)")
        return accid2msg_cache

    @cached_property
    def channel_cache(self):
        accid2msg_cache = self.channels_cache
        channel = self.channel
        if channel not in accid2msg_cache:
            accid2msg_cache[channel] = {}
        return accid2msg_cache[channel]

    def get(self, accid: str):
        msg = self.accid_to_msg.get(accid)
        if not msg:
            cached_msg = self.channel_cache.get(accid)
            if cached_msg:
                msg = cached_msg
                err(f"ACCID {accid}: using cached msg {msg['ts']}")
        return msg

    def delete_msg(self, accid: str):
        cache = self.channel_cache
        if accid in cache:
            del cache[accid]
            self.accid2msg_cache_updated = True

    def update(self, msg):
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
        channel_cache = self.channel_cache
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

    def close(self):
        if self.accid2msg_cache_updated:
            accid2msg_cache = self.channels_cache
            accid2msg_cache_path = self.accid2msg_cache_path
            err(f"Dumping updated ts_hints ({len(accid2msg_cache)} entries) to {accid2msg_cache_path}")
            makedirs(dirname(accid2msg_cache_path), exist_ok=True)
            with open(accid2msg_cache_path, 'w') as f:
                json.dump(accid2msg_cache, f, indent=4)


