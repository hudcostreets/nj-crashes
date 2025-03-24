from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

import pandas as pd
from dateutil.parser import parse
from git import Repo
from pandas import DataFrame, Series
from utz import err

from nj_crashes.fauqstats import FAUQStats
from nj_crashes.utils import TZ
from nj_crashes.utils.github import GithubCommit
from njsp.commit_crashes import get_repo, CommitCrashes, get_rundate, DEFAULT_ROOT_SHA, SHORT_SHA_LEN
from njsp.paths import CRASHES_RELPATH

Kind = Literal['add', 'update', 'del']


# class CrashesLog:
#     def __init__(self, df: DataFrame):
#         self.df = df
#
#     def __repr__(self):
#         return f"CrashesLog({len(self.crash_log)} rows)"


def get_crash_log(
    repo: Repo | None = None,
    head: str | None = None,
    since: str | datetime | pd.Timestamp | None = None,
    root: str | None = DEFAULT_ROOT_SHA,
    log: bool = True,
) -> DataFrame:
    if isinstance(since, (str, datetime)):
        tz = datetime.now(timezone.utc).astimezone().tzinfo
        since = pd.to_datetime(since).tz_localize(tz)

    crash_map = {}  # (accid: int) -> list[pd.Series]
    repo = repo or get_repo()
    # TODO: pass CRASHES_RELPATH directly here?
    commits = repo.iter_commits(head)
    shas = []
    using_gh_commits = False
    cur_commit = None
    cur_tree = None
    cur_fauqstats_blobs = None
    while True:
        try:
            if using_gh_commits:
                prv_commit = cur_commit.parent
            else:
                prv_commit = next(commits)
        except StopIteration:
            if len(shas) > 10:
                sha_strs = shas[:5] + ['...'] + shas[-5:]
            else:
                sha_strs = shas
            err(f"Ran out of commits after {len(shas)} ({','.join(sha_strs)}), switching to Github commit traversal")
            cur_commit = GithubCommit.from_git(cur_commit)
            cur_tree = cur_commit.tree
            cur_fauqstats_blobs = FAUQStats.blobs(cur_tree)
            prv_commit = cur_commit.parent
            using_gh_commits = True
        authored_datetime = pd.to_datetime(prv_commit.authored_datetime)
        if since and authored_datetime < since:
            err(f"Reached commit authored at {authored_datetime} before {since}, after {len(shas)} commits; breaking")
            break
        prv_tree = prv_commit.tree
        prv_short_sha = prv_commit.hexsha[:SHORT_SHA_LEN]
        shas.append(prv_short_sha)
        try:
            prv_fauqstats_blobs = FAUQStats.blobs(prv_tree)
        except KeyError:
            if prv_commit.hexsha == DEFAULT_ROOT_SHA:
                prv_fauqstats_blobs = None
            else:
                raise RuntimeError(f"Commit {prv_short_sha} lacks {CRASHES_RELPATH}")
        if cur_tree is not None and cur_fauqstats_blobs != prv_fauqstats_blobs:
            try:
                ts = pd.to_datetime(parse(get_rundate(cur_tree)))
                if ts.tz is None:
                    rundate = ts.tz_localize(TZ)
                else:
                    rundate = ts.tz_convert(TZ)
                cur_sha = cur_commit.hexsha[:SHORT_SHA_LEN]
                cc = CommitCrashes(cur_sha, log=log)

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

        if root and prv_commit and prv_commit.hexsha[:len(root)] == root:
            err(f"Reached root commit {root} after {len(shas)} commits; breaking")
            break

        # Step backward in history: current parent becomes child, next commit popped will be parent's parent
        cur_commit = prv_commit
        cur_tree = prv_tree
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
