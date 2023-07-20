from dataclasses import dataclass
from io import BytesIO
from typing import Union, Optional, Tuple

import pandas as pd
from utz import process, cached_property

from git import Commit, Repo


_repo: Optional[Repo] = None


def get_repo() -> Repo:
    global _repo
    if _repo is None:
        _repo = Repo()
    return _repo


def load_pqt(
        path: str,
        commit: Union[None, str, Commit] = None,
        repo: Optional[Repo] = None,
) -> pd.DataFrame:
    if repo is None:
        repo = get_repo()
    if commit is None:
        commit = repo.head.commit
    elif isinstance(commit, str):
        commit = repo.commit(commit)
    else:
        assert isinstance(commit, Commit), commit
    data = commit.tree[path].data_stream.read()
    return pd.read_parquet(BytesIO(data))


VICTIM_TYPES = {
    'D': 'driver',
    'P': 'passenger',
    'T': 'pedestrian',
    'B': 'cyclist',
}


def crash_str(r: pd.Series) -> str:
    victim_pcs = []
    for suffix, name in VICTIM_TYPES.items():
        num = r[f'FATAL_{suffix}']
        if num:
            noun = name if num == 1 else f'{name}s'
            victim_pcs.append(f'{num} {noun}')

    victim_str = ', '.join(victim_pcs)
    return f'{r.MNAME} ({r.CNAME} County), {r.LOCATION}: {victim_str} deceased'


@dataclass
class CommitCrashes:
    commit: str = None

    CRASHES_PATH = 'data/crashes.pqt'

    def fmt(self, fmt: str) -> str:
        return process.line('git', 'log', '-1', f'--format={fmt}', *([self.commit] if self.commit else []))

    @cached_property
    def sha(self) -> str:
        return self.fmt('%H')

    @cached_property
    def short_sha(self) -> str:
        return self.fmt('%h')

    @cached_property
    def parent(self) -> str:
        return f'{self.sha}~1'

    @cached_property
    def df0(self) -> pd.DataFrame:
        return load_pqt(self.CRASHES_PATH, commit=self.parent)

    @cached_property
    def df1(self) -> pd.DataFrame:
        return load_pqt(self.CRASHES_PATH, commit=self.commit)

    @cached_property
    def dfs(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        return self.df0, self.df1

    @cached_property
    def idx0(self) -> pd.Index:
        return self.df0.index

    @cached_property
    def idx1(self) -> pd.Index:
        return self.df1.index

    @cached_property
    def ids0(self) -> set[str]:
        return set(self.idx0)

    @cached_property
    def ids1(self) -> set[str]:
        return set(self.idx1)

    @cached_property
    def new_ids(self) -> list[str]:
        return list(self.idx1.difference(self.ids0))

    @cached_property
    def new_df(self) -> pd.DataFrame:
        return self.df1.loc[self.new_ids]

    @cached_property
    def removed_ids(self) -> list[str]:
        return list(self.ids0.difference(self.ids1))

    @cached_property
    def preserved_ids(self) -> list[str]:
        return list(self.ids0.intersection(self.ids1))

    @cached_property
    def columns(self):
        df0, df1 = self.dfs
        if (df0.columns != df1.columns).any():
            raise RuntimeError(f"Columns mismatch: {df0.columns} vs. {df1.columns}")
        return df0.columns

    @cached_property
    def changed_crashes(self) -> pd.DataFrame:
        preserved_ids = self.preserved_ids
        b0 = self.df0.loc[preserved_ids].sort_index().fillna('')
        b1 = self.df1.loc[preserved_ids].sort_index().fillna('')
        changed_rows = (b0 != b1).any(1)
        changed_sxs = pd.concat([ b0[changed_rows], b1[changed_rows], ], axis=1)
        changed_sxs.columns = pd.MultiIndex.from_tuples([
            (idx, col)
            for idx in [ 0, 1 ]
            for col in self.columns
        ])
        return changed_sxs

    @cached_property
    def changed_crash_ids(self) -> list[str]:
        return self.changed_crashes.index.tolist()

    @cached_property
    def diff_objs(self):
        diff_objs = {}
        df0, df1 = self.dfs
        for id in self.changed_crash_ids:
            r0 = df0.loc[id].fillna('')
            r1 = df1.loc[id].fillna('')
            fields = r0 != r1
            d0 = r0[fields].to_dict()
            d1 = r1[fields].to_dict()
            diff_obj = { k: [ v0, d1[k] ] for k, v0 in d0.items() }
            diff_objs[id] = diff_obj
        return diff_objs

    def descriptions(self):
        new_df = self.new_df
        return new_df.apply(crash_str, axis=1)

    def __str__(self):
        new_ids = self.new_ids
        if new_ids:
            noun = 'crash' if len(new_ids) == 1 else 'crashes'
            pcs = [f'Commit {self.short_sha}: {len(new_ids)} new {noun} ({",".join(new_ids)})']
        else:
            pcs = [f'Commit {self.short_sha}: no new crashes']
        removed_ids = self.removed_ids
        if removed_ids:
            noun = 'crash' if len(removed_ids) == 1 else 'crashes'
            pcs += [f'{len(removed_ids)} removed {noun} ({",".join(removed_ids)})']
        preserved_ids = self.preserved_ids
        pcs += [f'{len(preserved_ids)} IDs present in both']
        changed_crash_ids = self.changed_crash_ids
        if changed_crash_ids:
            pcs += [f'{len(changed_crash_ids)} changed ({",".join(changed_crash_ids)})']

        msg = ', '.join(pcs)
        return msg

    def __repr__(self):
        return str(self)


# def describe_commit_crashes(commit=None):
#     if commit is None:
#         commit = 'HEAD'
#     sha = process.line('git', 'log', '-1', '--format=%H', commit)
#     parent = f'{sha}~1'
#     path = 'data/crashes.pqt'
#     c0 = load_pqt(path, commit=parent)
#     c1 = load_pqt(path, commit=commit)
#     c1i = set(c1.index)
#     c0i = set(c0.index)
#     adds = list(c1i.difference(c0i))
#     dels = list(c0i.difference(c1i))
#     boths = c1i.intersection(c0i)
#
#     diffs = []
#     for both in boths:
#         r0 = c0.loc[both].fillna('')
#         r1 = c1.loc[both].fillna('')
#         if (r0 != r1).any():
#             diffs.append(both)
#
#     pcs = [f'{len(adds)} new crashes']
#     if dels:
#         pcs += [f'{len(dels)} removed crashes']
#     pcs += [f'{len(boths)} IDs present in both']
#     if diffs:
#         pcs += [f'{len(diffs)} changed']
#
#     msg = ', '.join(pcs)
#     print(msg)
#
#     diff_objs = {}
#     for diff in diffs:
#         r0 = c0.loc[diff].fillna('')
#         r1 = c1.loc[diff].fillna('')
#         fields = r0 != r1
#         d0 = r0[fields].to_dict()
#         d1 = r1[fields].to_dict()
#         diff_obj = { k: [ v0, d1[k] ] for k, v0 in d0.items() }
#         diff_objs[diff] = diff_obj
#     diff_objs
