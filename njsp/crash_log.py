import pandas as pd
from datetime import datetime, timezone
from dateutil.parser import parse
from typing import Optional, Union, Literal
from utz import err

from njsp.commit_crashes import get_repo, CommitCrashes, get_rundate, DEFAULT_ROOT_SHA, SHORT_SHA_LEN
from njsp.paths import CRASHES_RELPATH

Kind = Literal['add', 'update', 'del']


def get_crashes_df(
        repo=None,
        head: Union[str, None] = None,
        since: Union[str, datetime, pd.Timestamp, None] = None,
        root: Union[str, None] = DEFAULT_ROOT_SHA,
        load_pqt: bool = True,
) -> pd.DataFrame:
    if isinstance(since, (str, datetime)):
        tz = datetime.now(timezone.utc).astimezone().tzinfo
        since = pd.to_datetime(since).tz_localize(tz)

    crash_map = {}  # (accid: int) -> list[pd.Series]
    repo = repo or get_repo()
    # TODO: pass CRASHES_RELPATH directly here?
    commits = repo.iter_commits(head)
    shas = []
    cur_commit = None
    cur_tree = None
    cur_crashes_sha = None
    while True:
        try:
            prv_commit = next(commits)
        except StopIteration:
            raise RuntimeError(f"Ran out of commits after {len(shas)}: {','.join(shas)}")
        authored_datetime = pd.to_datetime(prv_commit.authored_datetime)
        if since and authored_datetime < since:
            err(f"Reached commit authored at {authored_datetime} before {since}, after {len(shas)} commits; breaking")
            break
        prv_tree = prv_commit.tree
        prv_short_sha = prv_commit.hexsha[:7]
        shas.append(prv_short_sha)
        try:
            prv_crashes_blob = prv_tree[CRASHES_RELPATH]
            prv_crashes_sha = prv_crashes_blob.hexsha
        except KeyError:
            if cur_commit.hexsha == DEFAULT_ROOT_SHA:
                prv_crashes_sha = None
            else:
                raise RuntimeError(f"Commit {prv_short_sha} lacks {CRASHES_RELPATH}")
        if cur_tree is not None and cur_crashes_sha != prv_crashes_sha:
            try:
                rundate = parse(get_rundate(cur_tree))
                cur_sha = cur_commit.hexsha[:SHORT_SHA_LEN]
                cc = CommitCrashes(cur_sha, load_pqt=load_pqt)

                def save(accid, crash: Optional[pd.Series], kind: Kind):
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

        if root and cur_commit and cur_commit.hexsha[:len(root)] == root:
            err(f"Reached root commit {root} after {len(shas)} commits; breaking")
            break

        # Step backward in history: current parent becomes child, next commit popped will be parent's parent
        cur_commit = prv_commit
        cur_tree = prv_tree
        cur_crashes_sha = prv_crashes_sha

    crashes_df = (
        pd.DataFrame([
            snapshot
            for snapshots in crash_map.values()
            for snapshot in snapshots
        ])
        .sort_values(['accid', 'rundate'])
        .set_index(['accid', 'sha'])
    )

    return crashes_df
