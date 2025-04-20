from functools import cache, cached_property
from os.path import join, exists

import atproto
from os import environ as env

from atproto_client.models.app.bsky.feed.defs import FeedViewPost
from dotenv import dotenv_values
from pandas import to_datetime
from utz import solo

from nj_crashes import ROOT_DIR
from nj_crashes.utils.log import err
from njsp.cli.bsky.post import BskyPost
from njsp.cli.bsky.thread import Thread
from njsp.crash import Log

USER_VAR = 'BSKY_USER'
PASS_VAR = 'BSKY_PASS'

# @crashes.hudcostreets.org was populated with all crashes from 2021-2025, at this commit ca. 2025-03-22
INITIAL_BACKFILL_SHA = '76a42ac4a457a47251a7225301f38d58b6d5db82'
MIN_RUNDATE = to_datetime('2025-03-23').tz_localize('US/Eastern')


@cache
def client():
    _client = atproto.Client()
    user = env.get(USER_VAR)
    pswd = env.get(PASS_VAR)
    if not user or not pswd:
        path = join(ROOT_DIR, ".bsky.env")
        if exists(path):
            config = dotenv_values(path)
            if not user:
                user = config.get(USER_VAR)
            if not pswd:
                pswd = config.get(PASS_VAR)
            if not user or not pswd:
                raise RuntimeError(f"Missing ${USER_VAR} or ${PASS_VAR}, including in {path}")
        else:
            raise RuntimeError(f"Missing ${USER_VAR} or ${PASS_VAR}, and {path} doesn't exist")
    _client.login(user, pswd)
    return _client


DEFAULT_BATCH_SIZE = 100  # bsky API max
DEFAULT_MAX_RECS = 10_000
HANDLE = 'crashes.hudcostreets.org'


class Client:
    def __init__(
        self,
        dry_run: bool = False,
    ):
        self.dry_run = dry_run

    @property
    def client(self) -> atproto.Client:
        return client()

    def feed_posts(
        self,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int = DEFAULT_MAX_RECS,
        handle: str = HANDLE,
    ) -> list[FeedViewPost]:
        recs = []
        cursor = None
        while len(recs) < max_recs:
            res = self.client.get_author_feed(actor=handle, limit=batch_size, cursor=cursor)
            feed = res.feed
            recs += feed
            err(f"Bsky: fetched batch of {len(feed)} posts ({len(recs)} total)")
            cursor = res.cursor
            if not cursor:
                break

        return recs

    def posts(self, **kwargs) -> list[BskyPost]:
        return list(filter(None, [
            BskyPost.from_feed_post(feed_post)
            for feed_post in
            self.feed_posts(**kwargs)
        ]))

    @cached_property
    def all_posts(self) -> list[BskyPost]:
        return self.posts()

    def sync_crash(
        self,
        accid: int,
        crash_log: Log,
    ):
        thread = Thread.from_posts(accid, [ p for p in self.all_posts if p.accid == accid ])
        root, *replies = thread.posts
        # root = thread.root
        backfill_root = thread.backfill_root
        # root = solo([ p for p in posts if not p.reply ], empty_ok=True)
        # if bool(posts) != bool(root):
        #     raise RuntimeError(f"{accid} missing root post ({len(posts)}): {posts}")

        v0 = []
        v1 = []
        for v in crash_log.versions:
            if v.rundate > MIN_RUNDATE:
                v1.append(v)
            else:
                v0.append(v)
        # if v0:
        #     backfill_post = solo([ p for p in posts if p.sha == INITIAL_BACKFILL_SHA ])
        # else:
        #     backfill_post = None

        if v1:
            if backfill_root:
                if len(replies) > len(v1):
                    raise RuntimeError(f"{accid}: {len(replies)=} > {len(v1)=}")
                for idx, (v, reply) in enumerate(zip(v1, replies)):
                    if v.sha != reply.sha:
                        raise RuntimeError(f"{accid}#{idx}: {v.sha=} != {reply.sha=}")
                for idx in range(len(replies), len(v1)):
                    v = v1[idx]
                    reply_to = thread.posts[idx - 1]
                    post = BskyPost.mk(
                        accid=accid,
                        sha=v.sha,
                        pcs=[
                            
                        ]
                        # text=v.text,
                        # reply=FeedViewPost(
                        #     parent=FeedViewPost(
                        #         uri=reply_to.post.uri,
                        #         cid=reply_to.post.cid,
                        #     ),
                        #     root=FeedViewPost(
                        #         uri=root.post.uri,
                        #         cid=root.post.cid,
                        #     ),
                        # ),
                    )
                    # if v.prev:
                    #     assert reply.reply.parent.uri == v.prev.sha
                    #     assert reply.reply.root.uri == INITIAL_BACKFILL_SHA
                    # else:
                    #     assert reply.reply is None
            else:
                pass
        else:
            assert backfill_root

