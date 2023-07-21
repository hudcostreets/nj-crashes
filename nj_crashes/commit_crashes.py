#!/usr/bin/env python

import json
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from os import environ as env
from subprocess import CalledProcessError
from typing import Union, Optional, Tuple, Callable

import click
import pandas as pd
from gitdb.exc import BadName
from github import Auth, Github
from github.Repository import Repository
from github.Commit import Commit as GithubCommit
from pandas import isna
from utz import process, cached_property

from git import Commit, Repo, Tree

_repo: Optional[Repo] = None


def get_repo() -> Repo:
    global _repo
    if _repo is None:
        _repo = Repo()
    return _repo


_gh: Optional[Github] = None
_gh_repo: Optional[Repository] = None
SHORT_SHA_LEN = 7
REPO = 'neighbor-ryan/nj-crashes'


def get_github_repo() -> Repository:
    global _gh
    global _gh_repo
    if _gh is None:
        GITHUB_TOKEN = env.get('GITHUB_TOKEN')
        if GITHUB_TOKEN:
            auth = Auth.Token(GITHUB_TOKEN)
            auth_kwargs = dict(auth=auth)
        else:
            auth_kwargs = dict()
        _gh = Github(**auth_kwargs)
    if _gh_repo is None:
        _gh_repo = _gh.get_repo(REPO)
    return _gh_repo


def load_pqt_github(
        path: str,
        ref: str = None,
        repo: Optional[Repository] = None,
) -> pd.DataFrame:
    if repo is None:
        repo = get_github_repo()
    content_bytes = repo.get_contents(path, ref=ref).decoded_content
    return pd.read_parquet(BytesIO(content_bytes))


def load_pqt(
        path: str,
        commit: Union[None, str, Commit] = None,
        repo: Optional[Repo] = None,
) -> pd.DataFrame:
    if repo is None:
        repo = get_repo()
    elif isinstance(repo, Github):
        return load_pqt_github(path, ref=commit)

    if commit is None:
        commit = repo.head.ref
    elif isinstance(commit, str):
        try:
            commit = repo.commit(commit)
        except (BadName, ValueError):
            return load_pqt_github(path, ref=commit)
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


def crash_str(r: pd.Series, fmt: Union[Callable, str] = '%a %b %-d %Y %-I:%M%p') -> str:
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
    return f'{dt_str}: {r.MNAME} ({r.CNAME} County), {r.LOCATION}: {victim_str} deceased'


@dataclass
class CommitCrashes:
    ref: Optional[str] = None

    CRASHES_PATH = 'data/crashes.pqt'
    RUNDATE_JSON_PATH = 'www/public/rundate.json'

    def fmt(self, fmt: str) -> str:
        return process.line('git', 'log', '-1', f'--format={fmt}', *([self.ref] if self.ref else []))

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
    def parent_ref(self) -> str:
        return f'{self.sha}~1'

    @cached_property
    def df0(self) -> pd.DataFrame:
        return load_pqt(self.CRASHES_PATH, commit=self.parent_ref)

    @cached_property
    def df1(self) -> pd.DataFrame:
        return load_pqt(self.CRASHES_PATH, commit=self.ref)

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
        changed_rows = (b0 != b1).any(axis=1)
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

    def descriptions(self, **kwargs) -> list[str]:
        new_df = self.new_df
        descriptions = new_df.apply(crash_str, **kwargs, axis=1)
        return descriptions.tolist() if len(descriptions) else []

    @cached_property
    def commit(self) -> Commit:
        return get_repo().commit(self.ref)

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
            "blocks": [{
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": self.mrkdwn,
                },
            }]
        }

    def slack_json_str(self, indent: Optional[int] = 2) -> str:
        return json.dumps(self.slack_json, indent=indent)

    @cached_property
    def rundate_json(self):
        path = self.RUNDATE_JSON_PATH
        try:
            rundate_blob = self.tree[path]
            rundate_bytes = rundate_blob.data_stream.read()
        except BadName:
            rundate_bytes = get_github_repo().get_contents(path, ref=self.ref).decoded_content
        return json.loads(rundate_bytes.decode())

    @cached_property
    def run_dt(self) -> pd.Timestamp:
        return pd.to_datetime(self.rundate_json['rundate'])

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
        new_ids = self.new_ids
        if new_ids:
            noun = 'crash' if len(new_ids) == 1 else 'crashes'
            pcs.append(f'{len(new_ids)} new {noun}')
        else:
            pcs.append(f'no new crashes')

        removed_ids = self.removed_ids
        if removed_ids:
            if pcs:
                pc = f'{len(removed_ids)} removed'
            else:
                noun = 'crash' if len(removed_ids) == 1 else 'crashes'
                pc = f'{len(removed_ids)} {noun} removed'
            pcs.append(pc)

        updated_ids = self.changed_crash_ids
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


@click.command('commit-crashes')
@click.option('-s', '--slack', is_flag=True)
@click.argument('commits', nargs=-1)
def main(slack, commits):
    if commits:
        commits = list(commits)
    else:
        commits = [None]

    ccs = [ CommitCrashes(commit) for commit in commits ]
    if slack:
        jsons = [ cc.slack_json for cc in ccs ]
        text = ', '.join([ obj['text'] for obj in jsons ])
        blocks = [ block for obj in jsons for block in obj['blocks'] ]
        # blocks = [{ 'type': 'mrkdwn', 'text': '\n'.join([ obj['blocks'][0]['text'] for obj in jsons ]) }]
        slack_json = { 'text': text, 'blocks': blocks, }
        print(json.dumps(slack_json, indent=2))
    else:
        for cc in ccs:
            print(cc.md)


if __name__ == "__main__":
    main()
