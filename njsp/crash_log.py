import pandas as pd
from dataclasses import dataclass, field
from datetime import datetime, timezone
from dateutil.parser import parse
from typing import Optional, Tuple, Union, Literal
from utz import err

from njsp.commit_crashes import get_repo, CommitCrashes, get_rundate, DEFAULT_ROOT_SHA, SHORT_SHA_LEN
from njsp.paths import CRASHES_RELPATH

Kind = Literal['add', 'update', 'del']


@dataclass
class Snapshot:
    sha: str
    rundate: str
    crash: Optional[pd.Series] = None
    prv: Optional['Snapshot'] = None

    @property
    def kind(self) -> Kind:
        return 'add' if self.prv is None else 'del' if self.crash is None else 'update'

    @property
    def diff_obj(self) -> dict[str, Tuple]:
        if self.prv is None:
            return {
                k: (None, v)
                for k, v in self.crash.to_dict().items()
            }
        if self.crash is None:
            return {
                k: (v, None)
                for k, v in self.prv.crash.to_dict().items()
            }
        prv = self.prv.crash
        cur = self.crash
        return {
            k: (prv[k], v)
            for k, v in cur.to_dict().items()
        }


@dataclass
class Crash:
    accid: int
    snapshots: list[Snapshot] = field(default_factory=list)

    @property
    def first(self) -> Snapshot:
        return self.snapshots[0]

    @property
    def last(self) -> Snapshot:
        return self.snapshots[-1]

    @property
    def cur(self) -> pd.Series:
        return self.last.crash

    @property
    def orig(self) -> pd.Series:
        return self.first.crash


def get_crashes(
        repo=None,
        head: Union[str, None] = None,
        since: Union[str, datetime, pd.Timestamp, None] = None,
        root: Union[str, None] = DEFAULT_ROOT_SHA,
) -> list[Crash]:
    if isinstance(since, (str, datetime)):
        tz = datetime.now(timezone.utc).astimezone().tzinfo
        since = pd.to_datetime(since).tz_localize(tz)

    crash_map = {}
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
                cc = CommitCrashes(cur_sha)

                def save(accid, *snapshot_args):
                    accid = int(accid)
                    if accid not in crash_map:
                        crash_map[accid] = Crash(accid=accid, snapshots=[])
                    snapshot = Snapshot(*snapshot_args)
                    crash_map[accid].snapshots.append(snapshot)

                # Added crashes
                for accid, crash in cc.adds_df.to_dict('index').items():
                    save(accid, cur_sha, rundate, crash)

                # Deleted crashes
                for accid in cc.del_ids:
                    save(accid, cur_sha, rundate)

                # Updated crashes
                for accid, crash in cc.updated_df.to_dict('index').items():
                    save(accid, cur_sha, rundate, crash)

            except Exception:
                raise RuntimeError(f"Error processing commit {cur_commit.hexsha}")

        if root and cur_commit and cur_commit.hexsha[:len(root)] == root:
            err(f"Reached root commit {root} after {len(shas)} commits; breaking")
            break

        # Step backward in history: current parent becomes child, next commit popped will be parent's parent
        cur_commit = prv_commit
        cur_tree = prv_tree
        cur_crashes_sha = prv_crashes_sha

    crashes = list(sorted(crash_map.values(), key=lambda c: c.accid))
    for crash in crashes:
        new_snapshots = []
        prv = None
        for cur in reversed(crash.snapshots):
            cur.prv = prv
            new_snapshots.append(cur)
            prv = cur
        crash.snapshots = new_snapshots

    return crashes


def get_crashes_df(
        repo=None,
        head: Union[str, None] = None,
        since: Union[str, datetime, pd.Timestamp, None] = None,
        root: Union[str, None] = DEFAULT_ROOT_SHA,
) -> pd.DataFrame:
    crashes = get_crashes(repo=repo, head=head, since=since, root=root)
    df = pd.DataFrame(crashes)
    return df
