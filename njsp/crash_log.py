from __future__ import annotations

from dataclasses import dataclass
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
from njsp.paths import CRASH_LOG_PQT, CRASHES_RELPATH
from njsp.utils import parse_rundate

Kind = Literal['add', 'update', 'del']

# `FAUQStats.crashes` columns — crash-log carries all of them (plus `rundate`/`kind`).
FAUQSTATS_COLS = [
    'CCODE', 'CNAME', 'MCODE', 'MNAME', 'STREET', 'HIGHWAY', 'LOCATION',
    'FATALITIES', 'FATAL_D', 'FATAL_P', 'FATAL_T', 'FATAL_B', 'INJURIES', 'dt',
]


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


def _collect_fauqstats_blobs(repo_dir: str, head: str | None, root: str | None) -> dict[str, bytes]:
    """Bulk-extract every unique `data/FAUQStats*.xml` blob in `root..head` via two
    `git cat-file --batch` passes (resolve refs -> blob shas, then fetch bytes) —
    far faster than GitPython per-blob tree access. Returns {blob_sha: raw_xml}.
    Best-effort: on any git error (e.g. `root` not present in a shallow history)
    returns {} and the walk parses on demand as before."""
    import subprocess
    head = head or 'HEAD'
    rng = f'{root}..{head}' if root else head
    try:
        rev = subprocess.run(['git', '-C', repo_dir, 'rev-list', rng],
                             capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError:
        return {}
    commits = rev.stdout.split()
    if not commits:
        return {}
    # Resolve `<commit>:data/FAUQStats<year>.xml` for every (commit, plausible year)
    # to a blob sha; missing paths report "missing" and are skipped.
    years = range(2008, datetime.now().year + 2)
    refs = [f'{c}:data/FAUQStats{y}.xml' for c in commits for y in years]
    bc = subprocess.run(['git', '-C', repo_dir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
                        input='\n'.join(refs) + '\n', capture_output=True, text=True)
    shas = {
        parts[0]
        for line in bc.stdout.splitlines()
        if len(parts := line.split()) == 2 and parts[1] == 'blob'
    }
    if not shas:
        return {}
    # Fetch the unique blobs' bytes in one batch pass (binary-safe).
    proc = subprocess.run(['git', '-C', repo_dir, 'cat-file', '--batch'],
                          input=('\n'.join(shas) + '\n').encode(), capture_output=True)
    out, blobs, i = proc.stdout, {}, 0
    while i < len(out):
        nl = out.find(b'\n', i)
        if nl < 0:
            break
        parts = out[i:nl].decode('ascii', 'replace').split()
        if len(parts) != 3 or parts[1] != 'blob':
            break
        sha, size = parts[0], int(parts[2])
        start = nl + 1
        blobs[sha] = out[start:start + size]
        i = start + size + 1  # skip the trailing newline cat-file appends
    return blobs


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
    # Parallel prewarm: parse every FAUQStats blob in range up front (thread pool,
    # GIL released in lxml), so the sequential walk below is all cache hits. Skips
    # cleanly if the range isn't fully local (walk falls back to on-demand parse).
    try:
        _blobs = _collect_fauqstats_blobs(repo.working_dir, head, root)
        if _blobs:
            FAUQStats.prewarm(_blobs, log=log)
    except Exception as e:
        log(f"FAUQStats prewarm skipped: {e}")
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


@dataclass
class FeedSnapshot:
    """The NJSP fatal-crash feed's view of one year, as of a point in time."""
    year: int
    rundate: Timestamp
    crashes: DataFrame  # indexed by ACCID; columns match `FAUQStats.crashes`


def feed_snapshot(
    year: int,
    as_of: str | datetime | Timestamp,
    crash_log: DataFrame | None = None,
) -> FeedSnapshot:
    """Reconstruct the NJSP feed's view of ``year``'s fatal crashes as of
    ``as_of``, by replaying ``crash-log.parquet`` add/update/del events.

    Equivalent to checking out ``FAUQStats{year}.xml`` from the oldest commit
    whose rundate is >= ``as_of`` — what ``njsp.ytd`` previously did via a
    git-history walk — but as a static parquet query. ``as_of`` is snapped
    forward to the first feed rundate on or after it, matching the walk's
    "oldest commit with rundate >= target" rule.
    """
    if crash_log is None:
        crash_log = pd.read_parquet(CRASH_LOG_PQT)
    cl = crash_log.reset_index()

    as_of = to_datetime(as_of)
    if as_of.tz is None:
        as_of = as_of.tz_localize(TZ)

    rundates = cl['rundate']
    earliest = rundates.min()
    if as_of < earliest:
        raise ValueError(f"crash-log starts at {earliest}; cannot reconstruct the feed as of {as_of}")
    on_or_after = rundates[rundates >= as_of]
    if on_or_after.empty:
        raise ValueError(f"crash-log has no rundate >= {as_of} (latest is {rundates.max()})")
    snapped = on_or_after.min()

    # Each accid's state at `snapped` is its latest event at or before it; the
    # crash is present unless that event is a deletion. Take whole rows (not a
    # per-column `groupby.last`, which would skip NaNs from an older event).
    latest = (
        cl[cl['rundate'] <= snapped]
        .sort_values('rundate', kind='stable')
        .drop_duplicates('accid', keep='last')
    )
    present = latest[latest['kind'] != 'del']
    crashes = present[present['dt'].dt.year == year].set_index('accid')[FAUQSTATS_COLS]
    crashes.index.name = 'ACCID'
    return FeedSnapshot(year=year, rundate=snapped, crashes=crashes)
