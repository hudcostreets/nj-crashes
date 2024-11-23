from dataclasses import asdict
from os.path import exists
from time import sleep

from atproto_client.models.app.bsky.richtext.facet import Main as Facet
from click import option
from pandas import read_parquet, Series, concat
from utz import singleton, err
from utz.ymd import dates, YMD

import njsp
from nj_crashes.utils.git import git_fmt
from njdot import cc2cn, cc2mc2mn
from njsp.cli.bsky.base import bsky
from njsp.commit_crashes import crash_str, BskyPost
from njsp.crashes import Crash
from njsp.paths import CRASHES_PQT, BSKY_CRASH_POSTS


HEAD = git_fmt(fmt="%H", log=False)


def to_msg(r: Series, ref: str):
    crash = Crash(str(r.name))
    github_url = crash.xml_url(ref)
    msg = crash_str(
        r,
        github_url=github_url,
        dst='bsky',
    )
    assert isinstance(msg, BskyPost)
    # return msg
    return Series(asdict(msg))


@bsky.command
@dates(default_start=YMD(2008), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308')
@option('-m', '--max-crashes', type=int, default=1000, help="Process up to this number of crashes")
@option('-n', '--dry-run', count=True, help="Avoid Slack API requests, cache updates, etc.")
@option('-r', '--ref', default=HEAD, help=f"Ref to use for GitHub URLs; defaults to HEAD ({HEAD})")
@option('-s', '--sleep-s', type=float, default=0.5, help="Sleep this many seconds between Bsky API requests")
def backfill(
    start: YMD,
    end: YMD,
    max_crashes: int,
    dry_run: int,
    ref: str,
    sleep_s: float,
):
    """Create Bluesky posts for existing crashes."""
    c = read_parquet(CRASHES_PQT)
    c['CNAME'] = c.cc.map(cc2cn)
    c['MNAME'] = c.apply(lambda r: cc2mc2mn[r.cc]['mc2mn'][r.mc], axis=1)
    c = c.rename(columns={'location': 'LOCATION'})
    if start:
        c = c[c.dt.dt.date >= start.date]
    if end:
        c = c[c.dt.dt.date < end.date]

    bsky_crash_posts = read_parquet(BSKY_CRASH_POSTS) if exists(BSKY_CRASH_POSTS) else None
    if not bsky_crash_posts.empty:
        bsky_crash_posts = bsky_crash_posts.set_index('accid')['uri']
        c = c[~c.index.isin(bsky_crash_posts.index)]

    if max_crashes:
        c = c.head(max_crashes)

    msgs = c.apply(
        to_msg,
        ref=ref,
        axis=1,
    )
    if dry_run:
        def print_msg(m: BskyPost):
            text = m.text
            facet: Facet = singleton(m.facets, dedupe=False)
            start = facet.index.byte_start
            end = facet.index.byte_end
            feature = singleton(facet.features, dedupe=False)
            url = feature.uri
            print(f'{text}; [{start}:{end}): {url}')

        msgs.apply(print_msg, axis=1)
    else:
        err(f"Posting {len(msgs)} crashes to bsky")
        client = njsp.cli.bsky.client()
        accid2uri = {}
        records = msgs.reset_index().to_dict('records')
        try:
            for r in records:
                accid = r['id']
                text = r['text']
                facets = r['facets']
                resp = client.send_post(text=text, facets=facets)
                err(f"Posted {accid}: {resp}")
                accid2uri[accid] = resp.uri
                if sleep_s:
                    sleep(sleep_s)
        finally:
            if accid2uri:
                new_posts = Series(accid2uri, name='uri')
                new_posts.index.name = 'accid'
                all_posts = concat([ bsky_crash_posts, new_posts ]).to_frame().reset_index()
                err(f"Saving len(new_posts) new Bsky posts to {BSKY_CRASH_POSTS} ({len(all_posts)} total)")
                all_posts.to_parquet(BSKY_CRASH_POSTS)
