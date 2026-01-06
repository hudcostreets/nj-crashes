from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

import pandas as pd
from git import Repo, Commit
from pandas import DataFrame, Series, to_datetime, Timestamp
from utz import err

from nj_crashes.utils import TZ
from nj_crashes.utils.github import GithubCommit, Blob
from nj_crashes.utils.log import Log
from njsp.commit_crashes import get_repo, CommitCrashes, get_rundate, SHORT_SHA_LEN, DEFAULT_ROOT_SHA_PARENT
from njsp.fauqstats import FAUQStats
from njsp.paths import CRASHES_RELPATH
from njsp.utils import parse_rundate

Kind = Literal['add', 'update', 'del']


def get_commit_crash_updates(
    prv_commit: Commit | GithubCommit,
    cur_commit: Commit | GithubCommit,
    cur_fauqstats_blobs: dict[int, Blob],
    log: Log = err,
):
    crash_map = {}
    try:
        prv_fauqstats_blobs = FAUQStats.blobs(prv_commit.tree)
    except KeyError:
        if prv_commit.hexsha == DEFAULT_ROOT_SHA_PARENT:
            prv_fauqstats_blobs = None
        else:
            raise RuntimeError(f"Commit {prv_commit.hexsha[:SHORT_SHA_LEN]} lacks {CRASHES_RELPATH}")
    cur_tree = cur_commit.tree
    if cur_tree is not None and cur_fauqstats_blobs != prv_fauqstats_blobs:
        try:
            ts = pd.to_datetime(parse_rundate(get_rundate(cur_tree)))
            if ts.tz is None:
                rundate = ts.tz_localize(TZ)
            else:
                rundate = ts.tz_convert(TZ)
            cur_sha = cur_commit.hexsha[:SHORT_SHA_LEN]
            cc = CommitCrashes(cur_sha, log=log)
            log(f"{cur_sha} ({cc.run_date_str}): found xml diff")

            def save(accid, crash: Series | None, kind: Kind):
                accid = int(accid)
                if accid not in crash_map:
                    crash_map[accid] = []
                snapshot = dict(accid=accid, sha=cur_sha, rundate=rundate, kind=kind, **(crash or {}))
                crash_map[accid].append(snapshot)

            # Added crashes
            for accid, crash in cc.adds_df.to_dict('index').items():
                save(accid, crash, 'add')

            # Deleted crashes
            for accid in cc.del_ids:
                save(accid, None, 'del')

            # Updated crashes
            for accid, crash in cc.updated_df.to_dict('index').items():
                save(accid, crash, 'update')

        except Exception:
            raise RuntimeError(f"Error processing commit {cur_commit.hexsha}")
    return prv_fauqstats_blobs, crash_map


def get_crash_log(
    repo: Repo | None = None,
    head: str | None = None,
    since: str | datetime | Timestamp | None = None,
    root: str | None = DEFAULT_ROOT_SHA_PARENT,
    log: Log = err,
) -> DataFrame:
    if isinstance(since, (str, datetime)):
        tz = datetime.now(timezone.utc).astimezone().tzinfo
        since = to_datetime(since).tz_localize(tz)

    crash_map = {}  # (accid: int) -> list[Series]
    repo = repo or get_repo()
    # TODO: pass CRASHES_RELPATH directly here?
    commits = repo.iter_commits(head)
    shas = []
    using_gh_commits = False
    try:
        cur_commit = next(commits)
    except StopIteration:
        err(f"Initial commit {head} not found locally, switching to Github commit traversal")
        cur_commit = GithubCommit.from_sha(head)
        using_gh_commits = True
    cur_fauqstats_blobs = FAUQStats.blobs(cur_commit.tree)
    while True:
        if root and cur_commit.hexsha[:len(root)] == root:
            err(f"Reached root commit {root} after {len(shas)} commits; breaking")
            break

        if using_gh_commits:
            prv_commit = cur_commit.parent
        else:
            try:
                prv_commit = next(commits)
            except StopIteration:
                if len(shas) > 10:
                    sha_strs = shas[:5] + ['...'] + shas[-5:]
                else:
                    sha_strs = shas
                err(f"Ran out of commits after {len(shas)} ({','.join(sha_strs)}), switching to Github commit traversal")
                using_gh_commits = True
                prv_commit = GithubCommit.from_sha(f'{cur_commit.hexsha}^')

        authored_datetime = to_datetime(prv_commit.authored_datetime)
        if since and authored_datetime < since:
            err(f"Reached commit authored at {authored_datetime} before {since}, after {len(shas)} commits; breaking")
            break
        shas.append(prv_commit.hexsha[:SHORT_SHA_LEN])

        prv_fauqstats_blobs, new_crash_versions = get_commit_crash_updates(
            prv_commit,
            cur_commit,
            cur_fauqstats_blobs,
            log=log,
        )
        for accid, versions in new_crash_versions.items():
            if accid not in crash_map:
                crash_map[accid] = []
            crash_map[accid].extend(versions)

        # Step backward in history: current parent becomes child, next commit popped will be parent's parent
        cur_commit = prv_commit
        cur_fauqstats_blobs = prv_fauqstats_blobs

    crash_log = DataFrame([
        snapshot
        for snapshots in crash_map.values()
        for snapshot in snapshots
    ])
    if not crash_log.empty:
        crash_log = (
            crash_log
            .sort_values(['accid', 'rundate'])
            .set_index(['accid', 'sha'])
        )

    return crash_log
