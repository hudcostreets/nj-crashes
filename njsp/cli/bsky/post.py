import re
from dataclasses import dataclass
from typing import Sequence

from atproto_client import models
from atproto_client.models.app.bsky.feed.defs import PostView
from atproto_client.models.app.bsky.feed.post import ReplyRef
from atproto_client.models.app.bsky.richtext.facet import Main as Facet, ByteSlice, Link as BskyLink
from atproto_client.models.com.atproto.repo.strong_ref import Main
from pandas import isna
from utz import solo

from njsp.cli.bsky.utils import HANDLE, uri2tid
from njsp.commit_crashes import Link
from njsp.crash import mk_dt_str, Version, Add, Update, Delete, Fmt
from njsp.crash.utils import DEFAULT_FMT

ACCID_RGX = re.compile(r'\d{4,5}')
ACCID_HREF_RGX0 = re.compile(r'https://github\.com/hudcostreets/nj-crashes/blob/(?P<sha>[0-9a-f]{40})/data/FAUQStats20\d\d\.xml#L\d+-L\d+')
ACCID_HREF_RGX1 = re.compile(r'https://github\.com/hudcostreets/nj-crashes/commit/(?P<sha>[0-9a-f]{8,40})\?diff=split#diff-[0-9a-f]{64}[LR]\d+-[LR]\d+')


def parse_facet(facet: Facet, text: str) -> tuple[int, str] | None:
    feature = solo(facet.features)
    if not isinstance(feature, models.AppBskyRichtextFacet.Link):
        return None
    uri = feature.uri

    index = facet.index
    text = text[index.byte_start:index.byte_end]

    if ACCID_RGX.fullmatch(text):
        accid = int(text)
    else:
        return None

    if m := ACCID_HREF_RGX0.fullmatch(uri):
        sha = m['sha']
    elif m := ACCID_HREF_RGX1.fullmatch(uri):
        sha = m['sha']
    else:
        return None

    return accid, sha


def bsky_text_facets(
    v: Add | Update,
    fmt: Fmt = DEFAULT_FMT,
) -> Sequence[str | Link]:
    victim_str = v.victim_str
    dt_str = mk_dt_str(v['dt'], fmt)
    if isna(v.LOCATION):
        location = 'unknown location'
    else:
        location = v.LOCATION.replace('&', '&amp;')

    github_url = v.xml_url(ref=v.sha)
    gh_link = Link(github_url, str(v.accid))

    c_url, m_url = v.urls
    c_link = Link(c_url, f'{v.CNAME} County')
    m_link = Link(m_url, v.MNAME)
    return [
        f'{dt_str} (', gh_link, '): ', m_link, ' (', c_link, f'), {location}: {victim_str} deceased',
    ]


@dataclass
class BskyPost:
    accid: int
    sha: str
    text: str
    facets: list[Facet]
    post: models.AppBskyFeedDefs.PostView | None = None

    @property
    def reply(self) -> ReplyRef | None:
        post = self.post
        if not post:
            return None
        else:
            return post.record.reply

    @property
    def reply_ref(self) -> Main:
        post = self.post
        return Main(
            cid=post.cid,
            uri=post.uri,
        )

    @property
    def url(self) -> str:
        tid = uri2tid(self.post.uri)
        return f"https://bsky.app/profile/{HANDLE}/post/{tid}"

    @staticmethod
    def mk(
        accid: int,
        sha: str,
        pcs: Sequence[str | Link],
    ) -> 'BskyPost':
        text = ""
        facets = []
        for pc in pcs:
            if isinstance(pc, str):
                text += pc
            elif isinstance(pc, Link):
                start = len(text)
                text += pc.text
                end = len(text)
                facet: Facet = Facet(
                    index=ByteSlice(byte_start=start, byte_end=end),
                    features=[BskyLink(uri=pc.uri)],
                )
                facets.append(facet)
            else:
                raise TypeError(pc)

        return BskyPost(accid=accid, sha=sha, text=text, facets=facets)

    @staticmethod
    def from_post(post: PostView) -> 'BskyPost | None':
        record = post.record
        text = record.text
        facets = record.facets
        accid_sha = solo(list(filter(None, [ parse_facet(facet, text) for facet in facets ])), empty_ok=True)
        if not accid_sha:
            return None
        accid, sha = accid_sha
        return BskyPost(
            accid=accid,
            sha=sha,
            text=text,
            facets=facets,
            post=post,
        )

    @staticmethod
    def from_version(v: Version, idx: int, n: int) -> 'BskyPost':
        rundate_str = v.rundate.strftime('%Y%m%d')
        if isinstance(v, Add):
            pcs = bsky_text_facets(v)
            if idx == 0:
                if n == 1:
                    pass
                else:
                    pcs = [ f"Added ({rundate_str}):\n&gt; ", *pcs ]
            else:
                pcs = [ f"Re-added ({rundate_str}):\n&gt; ", *pcs ]
        elif isinstance(v, Update):
            pcs = bsky_text_facets(v)
            pcs = [ f"Updated ({rundate_str}):\n&gt; ", *pcs ]
        elif isinstance(v, Delete):
            pcs = bsky_text_facets(v.prev)
            pcs = [ f"Deleted ({rundate_str}):\n&gt; ", *pcs ]
        else:
            raise ValueError(f"Invalid version type {v=}")
        return BskyPost.mk(
            accid=v.accid,
            sha=v.sha,
            pcs=pcs,
        )
