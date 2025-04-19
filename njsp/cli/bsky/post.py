import re
from dataclasses import dataclass
from typing import Callable, Sequence

from atproto_client import models
from atproto_client.models.app.bsky.feed.defs import FeedViewPost
from atproto_client.models.app.bsky.richtext.facet import Main as Facet, ByteSlice, Link as BskyLink
from pandas import Series, isna
from utz import solo, o

from njsp.commit_crashes import Link
from njsp.crash import Crash, mk_dt_str


ACCID_RGX = re.compile(r'\d{4,5}')
ACCID_HREF_RGX0 = re.compile(r'https://github\.com/hudcostreets/nj-crashes/blob/(?P<sha>[0-9a-f]{40})/data/FAUQStats20\d\d\.xml#L\d+-L\d+')
ACCID_HREF_RGX1 = re.compile(r'https://github\.com/hudcostreets/nj-crashes/commit/(?P<sha>[0-9a-f]{8,40})?diff=split#diff-[0-9a-f]{64}[LR]\d+-[LR]\d+')

# @crashes.hudcostreets.org was populated with all crashes from 2021-2025, at this commit ca. 2025-03-22
INITIAL_BACKFILL_SHA = '76a42ac4a457a47251a7225301f38d58b6d5db82'


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


@dataclass
class BskyPost:
    accid: int
    sha: str
    text: str
    facets: list[Facet]

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
    def from_feed_post(feed_post: FeedViewPost) -> 'BskyPost':
        post = feed_post.post
        record = post.record
        text = record.text
        facets = record.facets
        accid, sha = solo(list(filter(None, [ parse_facet(facet, text) for facet in facets ])))
        return BskyPost(
            accid=accid,
            sha=sha,
            text=text,
            facets=facets,
        )



def bsky_str(
    r: Series,
    sha: str,
    fmt: Callable | str = '%a %b %-d %Y %-I:%M%p',
    github_url: str | None = None,
) -> BskyPost:
    crash = Crash.load(r)
    victim_str = crash.victim_str
    dt_str = mk_dt_str(r['dt'], fmt)
    if isna(r.LOCATION):
        location = 'unknown location'
    else:
        location = r.LOCATION.replace('&', '&amp;')

    accid = int(r.name)
    accid_str = str(accid)
    gh_link = Link(uri=github_url, text=accid_str) if github_url else accid_str
    c_url, m_url = crash.urls
    c_link = Link(uri=c_url, text=f'{r.CNAME} County')
    m_link = Link(uri=m_url, text=r.MNAME)
    return BskyPost.mk(
        accid=accid,
        sha=sha,
        pcs=[f'{dt_str} (', gh_link, '): ', m_link, ' (', c_link, f'), {location}: {victim_str} deceased'],
    )
