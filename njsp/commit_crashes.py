#!/usr/bin/env python

import json
from datetime import datetime
from io import BytesIO
from os import environ as env
from os.path import exists
from subprocess import CalledProcessError
from typing import Union, Optional, Tuple, Callable

import pandas as pd
from gitdb.exc import BadName
from github import Auth, Github
from github.Repository import Repository
from github.Commit import Commit as GithubCommit
from pandas import isna
from utz import process, cached_property, err

from git import Commit, Repo, Tree, Object, Blob

from nj_crashes.paths import RUNDATE_RELPATH
from nj_crashes.utils import get_fauqstats
from njsp.paths import CRASHES_RELPATH

_repo: Optional[Repo] = None


def get_repo() -> Repo:
    global _repo
    if _repo is None:
        _repo = Repo()
    return _repo


_gh: Optional[Github] = None
_gh_repo: Optional[Repository] = None
SHORT_SHA_LEN = 8
REPO = 'neighbor-ryan/nj-crashes'


def get_github_repo() -> Repository:
    global _gh
    global _gh_repo
    if _gh is None:
        GITHUB_TOKEN = env.get('GITHUB_TOKEN')
        if not GITHUB_TOKEN:
            github_token_path = '.github_token'
            if exists(github_token_path):
                with open(github_token_path, 'r') as f:
                    GITHUB_TOKEN = f.read()
        if GITHUB_TOKEN:
            auth = Auth.Token(GITHUB_TOKEN)
            auth_kwargs = dict(auth=auth)
        else:
            auth_kwargs = dict()
        _gh = Github(**auth_kwargs)
    if _gh_repo is None:
        _gh_repo = _gh.get_repo(REPO)
    return _gh_repo


def load_github(
        path: str,
        ref: str = None,
        repo: Optional[Repository] = None,
) -> bytes:
    if repo is None:
        repo = get_github_repo()
    return repo.get_contents(path, ref=ref).decoded_content


def load_pqt_github(
        path: str,
        ref: str = None,
        repo: Optional[Repository] = None,
) -> pd.DataFrame:
    content_bytes = load_github(path, ref, repo)
    return pd.read_parquet(BytesIO(content_bytes))


def load_pqt_blob(blob: Object) -> pd.DataFrame:
    data = blob.data_stream.read()
    return pd.read_parquet(BytesIO(data))


def load_pqt(
        path: str,
        commit: Union[None, str, Commit, Blob] = None,
        repo: Union[Repo, Github, None] = None,
) -> pd.DataFrame:
    if isinstance(repo, Github):
        return load_pqt_github(path, ref=commit)

    if commit is None:
        repo = repo or get_repo()
        commit = repo.head.ref
    elif isinstance(commit, str):
        try:
            repo = repo or get_repo()
            commit = repo.commit(commit)
        except (BadName, ValueError):
            return load_pqt_github(path, ref=commit)

    if isinstance(commit, Blob):
        blob = commit
    elif isinstance(commit, Commit):
        blob = commit.tree[path]
    else:
        raise TypeError(commit)

    return load_pqt_blob(blob)


VICTIM_TYPES = {
    'D': 'driver',
    'P': 'passenger',
    'T': 'pedestrian',
    'B': 'cyclist',
}


def crash_str(
        r: pd.Series,
        fmt: Union[Callable, str] = '%a %b %-d %Y %-I:%M%p',
        github_url: Optional[str] = None
) -> str:
    victim_pcs = []
    for suffix, name in VICTIM_TYPES.items():
        num = r[f'FATAL_{suffix}']
        if not isna(num) and num > 0:
            num = int(num)
            noun = name if num == 1 else f'{name}s'
            victim_pcs.append(f'{num} {noun}')

    victim_str = ', '.join(victim_pcs)
    dt = r['dt']
    if callable(fmt):
        dt_str = fmt(dt)
    else:
        dt_str = dt.strftime(fmt)

    accid = r.name
    if github_url:
        github_link = f'<{github_url}|{accid}>'
    else:
        github_link = accid

    location = r.LOCATION.replace('&', '&amp;')
    return f'*{dt_str} ({github_link})*: {r.MNAME} ({r.CNAME} County), {location}: {victim_str} deceased'


def git_fmt(*refs: str, fmt: str = '%h', **kwargs) -> str:
    return process.line('git', 'log', '-1', f'--format={fmt}', *refs, **kwargs)


def get_rundate(tree: Tree) -> str:
    if RUNDATE_RELPATH in tree:
        rundate_blob = tree[RUNDATE_RELPATH]
        rundate_object = json.load(rundate_blob.data_stream)
        rundate = rundate_object["rundate"]
        return rundate
    else:
        data = tree['data']
        blobs = data.blobs
        xmls = {
            blob.name: blob
            for blob in blobs
            if blob.name.startswith('FAUQStats')
        }
        blob = list(xmls.values())[-1]
        fauqstats = get_fauqstats(blob.data_stream)
        rundate = fauqstats.RUNDATE.text
        return rundate


# data/crashes.pqt has been updated ≈daily since this commit on 2022-11-16
DEFAULT_ROOT_SHA = '3590e7d34cdae18cedfb1a661a3520ec679b544c'
# www/public/rundate.json has existed since this commit on 2022-12-10
# DEFAULT_ROOT_SHA = '448170bec'


class CommitCrashes:
    def __init__(self, ref: Union[str, Commit, None] = None, log=False):
        if isinstance(ref, Commit):
            self.ref = ref.hexsha
            self.commit = ref
        elif isinstance(ref, str):
            self.ref = ref
            self.commit = get_repo().commit(self.ref)
        elif ref is None:
            self.ref = git_fmt('HEAD', log=log)
            self.commit = get_repo().commit(self.ref)
        else:
            raise TypeError(ref)
        self.log = log

    def fmt(self, fmt: str) -> str:
        return git_fmt(self.ref, fmt=fmt, log=self.log)

    @cached_property
    def github_commit(self) -> GithubCommit:
        return get_github_repo().get_commit(self.ref)

    @cached_property
    def sha(self) -> str:
        try:
            return self.fmt('%H')
        except CalledProcessError:
            return self.github_commit.sha

    @cached_property
    def short_sha(self) -> str:
        try:
            return self.fmt('%h')
        except CalledProcessError:
            return self.github_commit.sha[:SHORT_SHA_LEN]

    @cached_property
    def parent_sha(self) -> str:
        return self.fmt('%P')

    @cached_property
    def parent_short_sha(self) -> str:
        return self.parent_sha[:SHORT_SHA_LEN]

    @cached_property
    def parent_ref(self) -> str:
        return f'{self.sha}~1'

    @property
    def parent(self) -> Commit:
        parents = self.commit.parents
        if len(parents) > 1:
            err(f"Expected 1 parent, got {len(parents)}: {parents}; returning first parent")
        return parents[0]

    @cached_property
    def df0(self) -> pd.DataFrame:
        if self.sha == DEFAULT_ROOT_SHA:
            return pd.DataFrame([], columns=self.df1.columns)
        else:
            return load_pqt(CRASHES_RELPATH, commit=self.parent)

    @cached_property
    def df1(self) -> pd.DataFrame:
        return load_pqt(CRASHES_RELPATH, commit=self.commit)

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
    def add_ids(self) -> list[str]:
        return list(self.idx1.difference(self.ids0))

    @cached_property
    def adds_df(self) -> pd.DataFrame:
        return self.df1.loc[self.add_ids]

    @cached_property
    def del_ids(self) -> list[str]:
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
        changed_rows = (b0 != b1).any(axis=1)
        changed_sxs = pd.concat([ b0[changed_rows], b1[changed_rows], ], axis=1)
        changed_sxs.columns = pd.MultiIndex.from_tuples([
            (idx, col)
            for idx in [ 0, 1 ]
            for col in self.columns
        ])
        return changed_sxs

    @cached_property
    def updated_ids(self) -> list[str]:
        return self.changed_crashes.index.tolist()

    @property
    def updated_df(self) -> pd.DataFrame:
        return self.df1.loc[self.updated_ids]

    @cached_property
    def diff_objs(self) -> dict[str, dict]:
        diff_objs = {}
        df0, df1 = self.dfs
        for id in self.updated_ids:
            r0 = df0.loc[id].fillna('')
            r1 = df1.loc[id].fillna('')
            fields = r0 != r1
            d0 = r0[fields].to_dict()
            d1 = r1[fields].to_dict()
            diff_obj = { k: [ v0, d1[k] ] for k, v0 in d0.items() }
            diff_objs[id] = diff_obj
        return diff_objs

    def descriptions(self, **kwargs) -> list[str]:
        new_df = self.adds_df
        descriptions = new_df.apply(crash_str, **kwargs, axis=1)
        return descriptions.tolist() if len(descriptions) else []

    @cached_property
    def tree(self) -> Tree:
        return self.commit.tree

    @cached_property
    def md(self) -> str:
        descriptions = self.descriptions(fmt=lambda dt: f"**{dt.strftime('%-I:%M%p').lower()}**")
        title = f'**{self.run_date_str}**, {", ".join(self.crash_type_pcs)}'
        if descriptions:
            title += ':'
        lines = [title]
        lines += [ f'- {line}' for line in descriptions ]
        return '\n'.join(lines)

    @cached_property
    def mrkdwn(self) -> str:
        descriptions = self.descriptions(fmt=lambda dt: f"*{dt.strftime('%-I:%M%p').lower()}*")
        subject = self.short_subject
        if descriptions:
            subject += ':'
        lines = [subject]
        lines += [ f'• {line}' for line in descriptions ]
        return '\n'.join(lines)

    @property
    def slack_json(self) -> dict:
        return {
            "text": self.short_subject,
        }

    def slack_json_str(self, indent: Optional[int] = 2) -> str:
        return json.dumps(self.slack_json, indent=indent)

    @cached_property
    def rundate(self):
        return get_rundate(self.tree)

    @cached_property
    def run_dt(self) -> pd.Timestamp:
        return pd.to_datetime(self.rundate)

    @cached_property
    def run_date(self) -> datetime.date:
        return self.run_dt.date()

    @property
    def run_date_str(self) -> str:
        return self.run_date.strftime('%a %b %-d %Y')

    @property
    def commit_link(self):
        return f'<{self.commit_url}|{self.short_sha}>'

    @property
    def commit_url(self) -> str:
        return f'https://github.com/{REPO}/commit/{self.sha}'

    @property
    def title(self) -> str:
        return f'{self.commit_link} ({self.run_date_str})'

    @property
    def crash_type_pcs(self) -> list[str]:
        pcs = []
        new_ids = self.add_ids
        if new_ids:
            noun = 'crash' if len(new_ids) == 1 else 'crashes'
            pcs.append(f'{len(new_ids)} new {noun}')
        else:
            pcs.append(f'no new crashes')

        removed_ids = self.del_ids
        if removed_ids:
            if pcs:
                pc = f'{len(removed_ids)} removed'
            else:
                noun = 'crash' if len(removed_ids) == 1 else 'crashes'
                pc = f'{len(removed_ids)} {noun} removed'
            pcs.append(pc)

        updated_ids = self.updated_ids
        if updated_ids:
            if pcs:
                pc = f'{len(updated_ids)} updated'
            else:
                noun = 'crash' if len(updated_ids) == 1 else 'crashes'
                pc = f'{len(updated_ids)} {noun} updated'
            pcs.append(pc)

        if not pcs:
            pcs = ['no crashes added, removed, or updated']
        return pcs

    # @property
    # def crash_updates(self) -> CrashUpdates:
    #     return CrashUpdates(
    #         sha=self.short_sha,
    #         adds=self.add_ids,
    #         dels=self.del_ids,
    #         diffs=self.diff_objs,
    #     )

    @property
    def subject(self) -> str:
        return f'{self.title}: ' + ', '.join(self.crash_type_pcs)

    @property
    def short_subject(self) -> str:
        return f'*{self.run_date_str}* ({self.commit_link}), {", ".join(self.crash_type_pcs)}'

    def __str__(self):
        return self.subject

    def __repr__(self):
        return str(self)
