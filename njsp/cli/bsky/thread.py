from dataclasses import dataclass

from njsp.cli.bsky.post import BskyPost
from njsp.cli.bsky.utils import INITIAL_BACKFILL_SHA


@dataclass
class Thread:
    accid: int
    posts: list[BskyPost]

    @staticmethod
    def from_posts(accid: int, posts: list[BskyPost]) -> 'Thread':
        posts = list(sorted(posts, key=lambda p: p.post.record.created_at))
        root = posts[0]
        for idx, (prv, cur) in enumerate(zip([None] + posts[:-1], posts)):
            if prv:
                p = cur.reply.parent
                if p.uri != prv.post.uri:
                    raise RuntimeError(f"{accid}#{idx}: {p.uri=} != {prv.post.uri=}")
                if p.cid != prv.post.cid:
                    raise RuntimeError(f"{accid}#{idx}: {p.cid=} != {prv.post.cid=}")
                r = cur.reply.root
                if r.uri != root.post.uri:
                    raise RuntimeError(f"{accid}#{idx}: {r.uri=} != {root.post.uri=}")
                if r.cid != root.post.cid:
                    raise RuntimeError(f"{accid}#{idx}: {r.cid=} != {root.post.cid=}")
            else:
                if cur.reply:
                    raise RuntimeError(f"{accid}#{idx}: expected root, not reply {cur.reply=}")

        return Thread(accid, posts)

    @property
    def root(self) -> BskyPost:
        return self.posts[0]

    @property
    def backfill_root(self) -> BskyPost | None:
        root = self.root
        if root.sha == INITIAL_BACKFILL_SHA:
            return root
        else:
            return None

    def __getitem__(self, idx: int) -> BskyPost:
        return self.posts[idx]
