import json
import warnings
from functools import cache, cached_property
from os import environ as env
from os import makedirs
from os.path import join, exists
from time import sleep
from typing import Sequence

# Suppress pydantic warning from atproto's generated models
warnings.filterwarnings('ignore', category=UserWarning, module='pydantic._internal._generate_schema')

import atproto
from atproto_client.models.app.bsky.feed.defs import PostView
from atproto_client.models.app.bsky.feed.post import ReplyRef
from dotenv import dotenv_values
from utz import solo, o

from nj_crashes import ROOT_DIR
from nj_crashes.utils.log import err
from njsp.cli.bsky.post import BskyPost, HANDLE
from njsp.cli.bsky.thread import Thread
from njsp.cli.bsky.utils import BACKFILL_RUNDATE, NETLOC, PATH_PREFIX
from njsp.crash import Log, Version
from njsp.utils import BLUE, RESET, GREEN, RED, YELLOW

USER_VAR = 'BSKY_USER'
PASS_VAR = 'BSKY_PASS'
DEFAULT_RETRY_INTERVALS = [1, 1, 1]

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


class Client:
    def __init__(
        self,
        dry_run: bool = False,
        overwrite_cache: bool = False,
    ):
        self.dry_run = dry_run
        self.overwrite_cache = overwrite_cache

    @property
    def client(self) -> atproto.Client:
        return client()

    def post_views(
        self,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_recs: int | None = None,
        handle: str = HANDLE,
        read_cache: bool = True,
        write_cache: bool = True,
        # ttl: str | int = '1d',
    ) -> list[PostView]:
        name = handle
        if max_recs is not None:
            name += f"_{max_recs}"
        else:
            max_recs = DEFAULT_MAX_RECS
        cache_dir = join(ROOT_DIR, ".bsky", "cache")
        cache_path = join(cache_dir, f"{name}.json")
        if exists(cache_path):
            if read_cache:
                # stat = os.stat(cache_key)
                # mtime = stat.st_mtime
                with open(cache_path, 'r') as f:
                    arr = json.load(f)
                posts = [ PostView(**r) for r in arr ]
                err(f"Bsky: loaded {len(posts)} feed posts from cache")
                return posts
            else:
                err(f"Bsky: skipping cache read {cache_path=}")

        posts = []
        cursor = None
        while len(posts) < max_recs:
            res = self.client.get_author_feed(actor=handle, limit=batch_size, cursor=cursor)
            batch = [ fpv.post for fpv in res.feed ]
            posts += batch
            err(f"Bsky: fetched batch of {len(batch)} posts ({len(posts)} total)")
            cursor = res.cursor
            if not cursor:
                break

        if write_cache:
            makedirs(cache_dir, exist_ok=True)
            with open(cache_path, 'w') as f:
                arr = [
                    rec.model_dump()
                    for rec in posts
                ]
                json.dump(arr, f)
                err(f"Bsky: saved {len(posts)} posts to {cache_path=}")
        else:
            err(f"Bsky: skipping cache write {cache_path=}")

        return posts

    def posts(self, **kwargs) -> list[BskyPost]:
        if self.overwrite_cache:
            kwargs['read_cache'] = False
        post_views = self.post_views(**kwargs)
        return list(filter(None, [
            BskyPost.from_post(post_view, post_views)
            for post_view in post_views
        ]))

    @cached_property
    def all_posts(self) -> list[BskyPost]:
        return self.posts()

    def sync_crash(
        self,
        accid: int,
        crash_log: Log,
        retry_intervals: Sequence[float] | None = None,
    ) -> tuple[list[PostView], Exception | None]:
        new_posts = []
        if not retry_intervals:
            retry_intervals = DEFAULT_RETRY_INTERVALS
        all_posts = self.all_posts
        accid_posts = [ p for p in all_posts if p.accid == accid ]
        if accid_posts:
            thread = Thread.from_posts(accid, accid_posts)
            posts = thread.posts
            root, *replies = posts
            backfill_root = thread.backfill_root
        else:
            posts = replies = []
            root = backfill_root = None
        post_backfill_versions = [
            v for v in crash_log.versions
            if v.rundate > BACKFILL_RUNDATE and not v.is_noop
        ]

        dry_run = self.dry_run
        def log(msg: str):
            if dry_run:
                msg = f"DRY RUN {msg}"
            err(f"{BLUE}{accid:>5d}: {msg}{RESET}")

        def get_post(v: Version, idx: int, offset: int) -> tuple[BskyPost, BskyPost | None, ReplyRef | None]:
            parent_idx = idx - offset
            if parent_idx >= 0:
                parent = posts[parent_idx]
                reply_to = ReplyRef(
                    parent=parent.reply_ref,
                    root=root.reply_ref,
                )
            else:
                parent = reply_to = None
            post = BskyPost.from_version(v, parent_idx + 1)
            return post, parent, reply_to

        def sync_posts(
            post_backfill_posts: list[BskyPost],
            all_posts: list[BskyPost] | None = None,
            offset: int = 0,
        ):
            if len(post_backfill_posts) > len(post_backfill_versions):
                raise RuntimeError(f"{accid}: {len(post_backfill_posts)=} > {len(post_backfill_versions)=}")
            for idx, (v, post) in enumerate(zip(post_backfill_versions, post_backfill_posts)):
                if v.sha != post.sha:
                    raise RuntimeError(f"{accid}#{idx}: {v.sha=} != {post.sha=}")
                else:
                    expected_post, _, _ = get_post(v, idx, offset)
                    expected_post.post = post.post
                    if post == expected_post:
                        log(f"post {post.url} is as expected: {post.text}")
                    else:
                        log(f"{YELLOW}post {post.url} doesn't match expected:")
                        ls0 = expected_post.str_lines
                        ls1 = post.str_lines
                        for l0, l1 in zip(ls0, ls1):
                            if l0 == l1:
                                log(f"{RESET} {l0}")
                            else:
                                log(f"-{RED}{l0}")
                                log(f"+{GREEN}{l1}")

            for idx in range(len(post_backfill_posts), len(post_backfill_versions)):
                v = post_backfill_versions[idx]
                post, parent, reply_to = get_post(v, idx, offset)
                log(f"new post{f' (reply to {parent.url} )' if parent else ''}:")
                for line in post.str_lines:
                    log(f"{GREEN}{line}")
                if dry_run:
                    new_post = o(cid='XXXDRYRUNXXX', uri=f'at://{NETLOC}{PATH_PREFIX}/XXXDRYRUNXXX')
                else:
                    res = self.client.send_post(
                        text=post.text,
                        facets=post.facets,
                        reply_to=reply_to,
                    )
                    uri = res.uri
                    new_post = None
                    for idx, sleep_s in enumerate(retry_intervals):
                        if idx > 0:
                            if idx == 1:
                                err(f"Failed to fetch new post {uri} after sleeping for {retry_intervals[0]}s, sleeping another {sleep_s}s then retrying...")
                            else:
                                err(f"Failed to fetch new post {uri}; sleeping {sleep_s}s then retrying...")
                        sleep(sleep_s)
                        res = self.client.get_posts([uri])
                        new_post = solo(res.posts, empty_ok=True)
                        if new_post:
                            break
                    if not new_post:
                        raise RuntimeError(f"Failed to fetch new post {uri} after creation (slept for {retry_intervals})")
                    new_posts.append(new_post)
                post.post = new_post
                nonlocal root
                if not root:
                    root = post
                post_backfill_posts.append(post)
                if all_posts:
                    all_posts.append(post)

        exc = None
        try:
            if post_backfill_versions:
                if backfill_root:
                    sync_posts(replies, all_posts=posts)
                else:
                    sync_posts(posts, offset=1)
            else:
                if not backfill_root:
                    log(f"no backfill root or subsequent versions found")
                else:
                    log(f"no updates necessary since backfilled {backfill_root.url}")
        except Exception as e:
            exc = e

        return new_posts, exc
