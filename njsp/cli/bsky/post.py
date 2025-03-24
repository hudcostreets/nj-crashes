from dataclasses import dataclass
from typing import Callable

from atproto_client.models.app.bsky.richtext.facet import Main as Facet, ByteSlice, Link as BskyLink
from pandas import Series, isna

from njsp.commit_crashes import mk_victim_str, mk_dt_str, Link, get_urls


@dataclass
class BskyPost:
    text: str
    facets: list[Facet]

    @staticmethod
    def mk(*pcs: str | Link) -> 'BskyPost':
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

        return BskyPost(text=text, facets=facets)


def bsky_str(
    r: Series,
    fmt: Callable | str = '%a %b %-d %Y %-I:%M%p',
    github_url: str | None = None,
) -> BskyPost:
    victim_str = mk_victim_str(r)
    dt_str = mk_dt_str(r['dt'], fmt)
    if isna(r.LOCATION):
        location = 'unknown location'
    else:
        location = r.LOCATION.replace('&', '&amp;')

    accid = str(r.name)
    gh_link = Link(uri=github_url, text=accid) if github_url else accid
    c_url, m_url = get_urls(r)
    c_link = Link(uri=c_url, text=f'{r.CNAME} County')
    m_link = Link(uri=m_url, text=r.MNAME)
    return BskyPost.mk(
        f'{dt_str} (', gh_link, '): ', m_link, ' (', c_link, f'), {location}: {victim_str} deceased',
    )
