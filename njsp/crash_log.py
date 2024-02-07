from io import BytesIO

import pandas as pd
from datetime import datetime, timezone

import json

from dataclasses import dataclass, field
from typing import Optional, Tuple, Union
from utz import err

from njsp.commit_crashes import get_repo, CommitCrashes, load_pqt, load_pqt_blob
from njsp.paths import CRASHES_RELPATH
from njsp.ytd import RUNDATE_RELPATH


@dataclass
class ShaDate:
    sha: str
    rundate: str


@dataclass
class CrashUpdate:
    sha: str
    rundate: str
    diff: dict[str, Tuple]


@dataclass
class CrashLog:
    accid: str
    added: ShaDate
    updates: list[CrashUpdate] = field(default_factory=list)
    deled: Optional[ShaDate] = None
    cur: Optional[pd.Series] = None
    orig: Optional[pd.Series] = None


def get_crash_logs(
        repo=None,
        since: Union[str, datetime, pd.Timestamp, None] = None,
) -> list['CrashLog']:
    if isinstance(since, (str, datetime)):
        tz = datetime.now(timezone.utc).astimezone().tzinfo
        since = pd.to_datetime(since).tz_localize(tz)

    # accid -> ShaDate
    adds = {}
    # accid -> Series, iff updates are detected
    origs = {}
    # accid -> {sha, rundate}
    dels = {}
    # accid -> [CrashUpdate]
    crash_updates = {}
    repo = repo or get_repo()
    commits = repo.iter_commits()
    shas = []
    cur_commit = None
    cur_tree = None
    cur_crashes_sha = None
    orig_crashes = None
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
        prv_crashes_blob = prv_tree[CRASHES_RELPATH]
        if orig_crashes is None:
            orig_crashes = load_pqt_blob(prv_crashes_blob)
        prv_crashes_sha = prv_crashes_blob.hexsha
        if cur_tree is not None and cur_crashes_sha != prv_crashes_sha:
            try:
                rundate_blob = cur_tree[RUNDATE_RELPATH]
                rundate_object = json.load(rundate_blob.data_stream)
                rundate = rundate_object["rundate"]
                cc = CommitCrashes(cur_commit.hexsha)
                sha_date = ShaDate(cur_commit.hexsha, rundate)

                # Added crashes
                for accid, crash in cc.adds_df.to_dict('index').items():
                    if accid in adds:
                        err(f"Duplicate add for {accid}: {adds[accid]} vs. {sha_date}")
                    adds[accid] = sha_date

                # Deleted crashes
                for accid in cc.del_ids:
                    if accid in dels:
                        err(f"Duplicate del for {accid}: {dels[accid]} vs. {sha_date}")
                    dels[accid] = sha_date

                # Updated crashes
                for accid, diffs in cc.diff_objs.items():
                    if accid not in crash_updates:
                        crash_updates[accid] = []
                    crash_updates[accid].append(CrashUpdate(sha_date.sha, sha_date.rundate, diffs))

                # For any crashes where we've just seen the first update or deletion, since it was initially added, save
                # a denormalized copy of the initial ("original") crash info.
                orig_ids_to_check = cc.del_ids + cc.updated_ids
                orig_ids_to_add = [
                    accid
                    for accid in orig_ids_to_check
                    if accid not in origs
                ]
                if orig_ids_to_add:
                    prv_crashes = load_pqt_blob(prv_crashes_blob)
                    del_crashes = prv_crashes.loc[orig_ids_to_add]
                    for accid, crash in del_crashes.to_dict('index').items():
                        origs[accid] = crash
            except Exception:
                raise RuntimeError(f"Error processing commit {cur_commit.hexsha}")

        # Step backward in history: current parent becomes child, next commit popped will be parent's parent
        cur_commit = prv_commit
        cur_tree = prv_tree
        cur_crashes_sha = prv_crashes_sha

    crash_logs = []
    for accid, added in adds.items():
        deled = dels.get(accid)
        updates = crash_updates.get(accid)
        try:
            cur = orig_crashes.loc[accid]
        except KeyError:
            cur = None
        orig = origs.get(accid)
        crash_log = CrashLog(
            accid=accid,
            added=added,
            updates=updates,
            deled=deled,
            cur=cur,
            orig=orig,
        )
        crash_logs.append(crash_log)

    for accid, diffs in crash_updates.items():
        if accid not in adds:
            err(f"Found `updates` for {accid} without an `add`:\n\t%s" % '\n\t'.join(map(str, diffs)))

    for accid, sha_date in dels.items():
        if accid not in adds:
            err(f"Found `del` for {accid} without an `add`: {sha_date}")

    return crash_logs
