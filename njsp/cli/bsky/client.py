from functools import cache
from os.path import join, exists

import atproto
from os import environ as env

from atproto_client.models.app.bsky.feed.defs import FeedViewPost
from dotenv import dotenv_values

from nj_crashes import ROOT_DIR
from nj_crashes.utils.log import err
from njsp.cli.bsky.post import BskyPost

USER_VAR = 'BSKY_USER'
PASS_VAR = 'BSKY_PASS'


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


DEFAULT_BATCH_SIZE = 100
DEFAULT_MAX_RECS = 10_000
HANDLE = 'crashes.hudcostreets.org'


class Client:
    dry_run: bool = False

    @property
    def client(self) -> atproto.Client:
        return client()

    def feed_posts(
        self,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int = DEFAULT_MAX_RECS,
    ) -> list[FeedViewPost]:
        recs = []
        cursor = None
        while len(recs) < max_recs:
            res = self.client.get_author_feed(HANDLE, limit=batch_size, cursor=cursor)
            feed = res.feed
            recs += feed
            err(f"Bsky: fetched batch of {len(feed)} posts ({len(recs)} total)")
            cursor = res.cursor
            if not cursor:
                break

        return recs

    def posts(
        self,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int = DEFAULT_MAX_RECS,
    ):
        return [
            BskyPost.from_feed_post(feed_post)
            for feed_post in
            self.feed_posts(batch_size=batch_size, max_recs=max_recs)
        ]
