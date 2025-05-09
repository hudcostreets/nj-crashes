from contextlib import nullcontext
from dataclasses import asdict
from functools import cache
from time import sleep
from urllib.parse import urlparse

import utz
from click import option
from fsspec import filesystem
from pandas import read_parquet, Series, concat, isna
from utz import singleton, err
from utz.ymd import dates, YMD

import njsp
from nj_crashes.utils.git import git_fmt
from nj_crashes.utils.log import none
from njdot import cc2cn, cc2mc2mn
from njsp.cli.bsky.base import bsky
from njsp.cli.bsky.post import BskyPost
from njsp.commit_crashes import Link
from njsp.crash import Crash, mk_dt_str
from njsp.crash.utils import DEFAULT_FMT, Fmt
from njsp.paths import CRASHES_PQT, BSKY_CRASH_POSTS_S3


@cache
def head():
    return git_fmt(fmt="%H", log=none)


def to_msg(r: Series, sha: str):
    crash = Crash(str(r.name))
    github_url = crash.xml_url(sha)
    msg = bsky_str(r, sha=sha, github_url=github_url)
    return Series(asdict(msg))


RENAMES = {
    'dk': 'FATAL_D',
    'ok': 'FATAL_P',
    'pk': 'FATAL_T',
    'bk': 'FATAL_B',
    'location': 'LOCATION',
}
DEFAULT_MAX_CRASHES = 1600
max_crashes_opt = option('-m', '--max-crashes', type=int, default=DEFAULT_MAX_CRASHES, help=f"Process up to this number of crashes (default: {DEFAULT_MAX_CRASHES})")
dry_run_opt = option('-n', '--dry-run', count=True, help="Avoid Bluesky API requests, cache updates, etc.")
parquet_url_opt = option('-p', '--parquet-url', default=BSKY_CRASH_POSTS_S3, help=f'Parquet file containing record of existing posts (default: {BSKY_CRASH_POSTS_S3})')
sleep_opt = option('-s', '--sleep-s', type=float, default=0.5, help="Sleep this many seconds between Bsky API requests")


def bsky_str(
    r: Series,
    sha: str,
    fmt: Fmt = DEFAULT_FMT,
    github_url: str | None = None,
) -> BskyPost:
    """Used in initial ``bsky backfill``."""
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


@bsky.command
@dates(default_start=YMD(2020), help='Date range to filter crashes to, e.g. `202307-`, `20230710-202308 (default: "2020-")')
@max_crashes_opt
@dry_run_opt
@parquet_url_opt
@option('-r', '--ref', default=head(), help=f"Ref to use for GitHub URLs; defaults to HEAD ({head()})")
@sleep_opt
def backfill(
    start: YMD,
    end: YMD,
    max_crashes: int,
    dry_run: int,
    parquet_url: str,
    sha: str,
    sleep_s: float,
):
    """Initial "backfill" of Bluesky posts for existing crashes, 2020–20250322.

    The format of posts has since been updated, and oriented around crash ``Version``s, so this command is not expected
    to be used/useful going forward. It was run once, at SHA ``INITIAL_BACKFILL_SHA``, to seed the account with a
    snapshot of ≈3000 crashes from 2020–20250322.
    """
    c = read_parquet(CRASHES_PQT)
    c['CNAME'] = c.cc.map(cc2cn)
    c['MNAME'] = c.apply(lambda r: cc2mc2mn[r.cc].mc2mn[r.mc], axis=1)
    c = c.rename(columns=RENAMES)
    if start:
        c = c[c.dt.dt.date >= start.date]
    if end:
        c = c[c.dt.dt.date < end.date]

    parsed = urlparse(parquet_url)
    scheme = parsed.scheme
    fs = filesystem(scheme)
    if scheme == 's3':
        ctx = utz.s3.atomic_edit(parquet_url)
    else:
        ctx = nullcontext(parquet_url)
    with ctx as out_path:
        bsky_crash_posts = read_parquet(parquet_url) if fs.exists(parquet_url) else None
        if bsky_crash_posts is not None:
            bsky_crash_posts = bsky_crash_posts.set_index('accid')['uri']
            c = c[~c.index.isin(bsky_crash_posts.index)]

        if max_crashes:
            c = c.head(max_crashes)

        sha = git_fmt(sha, fmt='%H', log=none)
        msgs = c.apply(
            to_msg,
            sha=sha,
            axis=1,
        )
        if dry_run:
            def print_msg(m: BskyPost):
                text = m.text
                print(text)
                for facet in m.facets:
                    start = facet.index.byte_start
                    end = facet.index.byte_end
                    feature = singleton(facet.features, dedupe=False)
                    url = feature.uri
                    print(" " * start + "^" * (end - start) + f" [{start}-{end}): {url}")
                print()

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
                    err(f"Saving {len(new_posts)} new Bsky posts to {out_path} ({len(all_posts)} total)")
                    all_posts.to_parquet(out_path, index=False)


@bsky.command
@max_crashes_opt
@dry_run_opt
@parquet_url_opt
@sleep_opt
def delete(
    max_crashes: int,
    dry_run: int,
    parquet_url: str,
    sleep_s: float,
):
    """Delete most recent crash posts."""
    parsed = urlparse(parquet_url)
    scheme = parsed.scheme
    if scheme == 's3':
        ctx = utz.s3.atomic_edit(parquet_url)
    else:
        ctx = nullcontext(parquet_url)
    with ctx as out_path:
        bsky_crash_posts = read_parquet(parquet_url, columns=['accid', 'uri'])
        if max_crashes:
            to_delete = bsky_crash_posts.tail(max_crashes)
        else:
            to_delete = bsky_crash_posts

        if dry_run:
            for r in to_delete.itertuples():
                accid = r.accid
                uri = r.uri
                err(f"Would delete {accid}: {uri}")
        else:
            client = njsp.cli.bsky.client()
            deleted = []
            try:
                for r in to_delete.itertuples():
                    accid = r.accid
                    uri = r.uri
                    resp = client.delete_post(uri)
                    err(f"Deleted {accid}: {resp}")
                    deleted.append(accid)
                    if sleep_s:
                        sleep(sleep_s)
            finally:
                if deleted:
                    err(f"Deleted {len(deleted)} Bsky posts")
                    bsky_crash_posts = bsky_crash_posts[~bsky_crash_posts.accid.isin(deleted)]
                    bsky_crash_posts.to_parquet(out_path, index=False)
