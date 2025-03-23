import json
from dataclasses import dataclass
from re import fullmatch

from atproto_client.models.app.bsky.richtext.facet import Main as Facet, ByteSlice, Link as BskyLink
import pandas as pd
from datetime import datetime
from git import Commit, Repo, Tree, Object, Blob
from gitdb.exc import BadName
from github import Github
from github.Commit import Commit as GithubCommit
from io import BytesIO
from pandas import isna, Series, read_parquet
from subprocess import CalledProcessError
from typing import Union, Optional, Tuple, Callable, Literal
from utz import process, cached_property, err

from nj_crashes.fauqstats import get_fauqstats, FAUQStats
from nj_crashes.utils.git import git_fmt, get_repo, SHORT_SHA_LEN
from nj_crashes.utils import SITE
from nj_crashes.utils.github import get_github_repo, load_pqt_github, REPO, GithubCommit as GithubCommitWrapper
from nj_crashes.utils.log import none
from njdot import cc2mc2mn, normalize_name
from njsp.paths import RUNDATE_RELPATH, MC_PQT


def load_pqt_blob(blob: Object) -> pd.DataFrame:
    data = blob.data_stream.read()
    return pd.read_parquet(BytesIO(data))


def load_pqt(
        path: Union[str, list[str]],
        commit: Union[None, str, Commit, Blob] = None,
        repo: Union[Repo, Github, None] = None,
) -> pd.DataFrame:
    if isinstance(path, list):
        for p in path:
            try:
                return load_pqt(p, commit=commit, repo=repo)
            except KeyError:
                pass
        raise KeyError(f"None of {path} were found in {commit}")

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
Dst = Literal['slack', 'markdown']


@dataclass
class Link:
    uri: str
    text: str


@dataclass
class BskyPost:
    text: str
    facets: list[Facet]

    @staticmethod
    def mk(*pcs: str | Link) -> 'BskyPost':
        text = ""
        facets = []
        for pc in pcs:
            if isinstance(pc, str):
                text += pc
            elif isinstance(pc, Link):
                start = len(text)
                text += pc.text
                end = len(text)
                facet: Facet = Facet(
                    index=ByteSlice(byte_start=start, byte_end=end),
                    features=[BskyLink(uri=pc.uri)],
                )
                facets.append(facet)
            else:
                raise TypeError(pc)

        return BskyPost(text=text, facets=facets)


def mk_victim_str(r: Series):
    victim_pcs = []
    for suffix, name in VICTIM_TYPES.items():
        num = r[f'FATAL_{suffix}']
        if not isna(num) and num > 0:
            num = int(num)
            noun = name if num == 1 else f'{name}s'
            victim_pcs.append(f'{num} {noun}')

    return ', '.join(victim_pcs)


def mk_dt_str(dt: pd.Timestamp, fmt: Union[Callable, str]) -> str:
    if callable(fmt):
        return fmt(dt)
    else:
        return dt.strftime(fmt)


def get_urls(r: Series) -> Tuple[str, str]:
    if 'cc' not in r or 'mc' not in r:
        if 'cc' in r or 'mc' in r:
            raise ValueError(f"{'cc' in r=}, {'mc' in r=}")
        if not 'CCODE' in r and 'MCODE' in r:
            raise ValueError(f"Missing 'cc' and 'mc', required {'CCODE' in r=} and {'MCODE' in r=}")
        cc = int(r.CCODE)
        if not fullmatch(r'\d{4}', r.MCODE):
            raise ValueError(f"Invalid MCODE {r.MCODE}")
        if r.MCODE[:2] != r.CCODE:
            raise ValueError(f"Invalid MCODE {r.MCODE} for CCODE {r.CCODE}")
        mc = int(r.MCODE[2:])
        sp2gin = read_parquet(MC_PQT)
        mc_gin = sp2gin[sp2gin.cc == cc].set_index('mc_sp').mc_gin.to_dict()[mc]
        if mc != mc_gin:
            err(f"cc {cc}: re-mapping mc {mc} to {mc_gin}")
            mc = mc_gin
    else:
        cc = r.cc
        mc = r.mc
    county = cc2mc2mn[cc]
    cs = normalize_name(county.cn)
    ms = normalize_name(county.mc2mn[mc])
    c_url = f'{SITE}/c/{cs}'
    m_url = f'{SITE}/c/{cs}/{ms}'
    return c_url, m_url


def bsky_str(
    r: pd.Series,
    fmt: Union[Callable, str] = '%a %b %-d %Y %-I:%M%p',
    github_url: Optional[str] = None,
) -> BskyPost:
    victim_str = mk_victim_str(r)
    dt_str = mk_dt_str(r['dt'], fmt)
    if isna(r.LOCATION):
        location = 'unknown location'
    else:
        location = r.LOCATION.replace('&', '&amp;')

    accid = str(r.name)
    gh_link = Link(uri=github_url, text=accid) if github_url else accid
    c_url, m_url = get_urls(r)
    c_link = Link(uri=c_url, text=f'{r.CNAME} County')
    m_link = Link(uri=m_url, text=r.MNAME)
    return BskyPost.mk(
        f'{dt_str} (', gh_link, '): ', m_link, ' (', c_link, f'), {location}: {victim_str} deceased',
    )


def crash_str(
    r: pd.Series,
    fmt: Union[Callable, str] = '%a %b %-d %Y %-I:%M%p',
    github_url: Optional[str] = None,
    dst: Dst = 'slack',
) -> str:
    victim_str = mk_victim_str(r)
    dt_str = mk_dt_str(r['dt'], fmt)
    if isna(r.LOCATION):
        location = 'unknown location'
    else:
        location = r.LOCATION.replace('&', '&amp;')

    def link(uri: str, text: str) -> str:
        nonlocal dst
        if dst == 'slack':
            return f'<{uri}|{text}>'
        else:
            return f'[{text}]({uri})'

    accid = str(r.name)
    if github_url:
        gh_link = link(github_url, accid)
    else:
        gh_link = f'{accid}'

    c_url, m_url = get_urls(r)
    c_link = link(uri=c_url, text=f'{r.CNAME} County')
    m_link = link(uri=m_url, text=r.MNAME)
    return f'*{dt_str} ({gh_link})*: {m_link} ({c_link}), {location}: {victim_str} deceased'


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


# data/FAUQStats2*.xml have been updated ≈daily since this commit on 2022-11-16
DEFAULT_ROOT_SHA = '96faa3bb36b4174bbf485411f9d634804aa89a82'


class CommitCrashes:
    def __init__(
            self,
            ref: Union[str, Commit, None] = None,
            log: bool = False,
            year: Optional[int] = None,
    ):
        if isinstance(ref, Commit):
            self.ref = ref.hexsha
            self.commit = ref
        elif isinstance(ref, str):
            self.ref = ref
            try:
                self.commit = get_repo().commit(self.ref)
            except BadName:
                github_commit = get_github_repo().get_commit(self.ref)
                commit_sha = github_commit.sha
                err(f"Didn't find ref {ref}, attempting to fetch {commit_sha}")
                remote = f'https://github.com/{REPO}'
                process.run('git', 'fetch', '--depth=2', remote, commit_sha)
                self.commit = get_repo().commit(commit_sha)
        elif ref is None:
            self.ref = git_fmt('HEAD', log=log)
            self.commit = get_repo().commit(self.ref)
        else:
            raise TypeError(ref)
        self.log = log
        self.year = year

    def fmt(self, fmt: str) -> str:
        return git_fmt(self.ref, fmt=fmt, log=False)

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
            parent_shas = [ parent.hexsha[:SHORT_SHA_LEN] for parent in parents ]
            err(f"Expected 1 parent, got {len(parents)}: {parent_shas}; returning first parent")
        parent = parents[0]
        try:
            parent.tree
        except ValueError:
            parent = get_github_repo().get_commit(parent.hexsha)
            parent = GithubCommitWrapper(parent)
        return parent

    @cached_property
    def year_xml_diffs(self) -> dict[int, Tuple[pd.DataFrame, pd.DataFrame]]:
        cur_fauq_blobs = FAUQStats.blobs(self.commit)
        prv_fauq_blobs = FAUQStats.blobs(self.parent)
        year_xml_diffs = {}
        for year, cur_blob in cur_fauq_blobs.items():
            prv_blob = prv_fauq_blobs.get(year)
            if prv_blob is None or cur_blob.hexsha != prv_blob.hexsha:
                cur_fauqstats = FAUQStats.load(cur_blob, log=err if self.log else none)
                cur_crashes = cur_fauqstats.crashes
                if prv_blob is None:
                    prv_crashes = pd.DataFrame([], columns=cur_crashes.columns)
                else:
                    prv_fauqstats = FAUQStats.load(prv_blob, log=err if self.log else none)
                    prv_crashes = prv_fauqstats.crashes
                year_xml_diffs[year] = prv_crashes, cur_crashes
        return year_xml_diffs

    @cached_property
    def df0(self) -> pd.DataFrame:
        if self.parent_sha == DEFAULT_ROOT_SHA:
            return pd.DataFrame([], columns=self.df1.columns)
        else:
            year = self.year
            year_xml_diffs = self.year_xml_diffs
            if year:
                if year in year_xml_diffs:
                    return year_xml_diffs[year][0]
                else:
                    return pd.DataFrame([])
            else:
                return pd.concat([
                    prv_crashes
                    for year, (prv_crashes, _) in year_xml_diffs.items()
                ]) if year_xml_diffs else pd.DataFrame([])

    @cached_property
    def df1(self) -> pd.DataFrame:
        year = self.year
        year_xml_diffs = self.year_xml_diffs
        if year:
            if year in year_xml_diffs:
                return year_xml_diffs[year][1]
            else:
                return pd.DataFrame([])
        else:
            return pd.concat([
                cur_crashes
                for year, (_, cur_crashes) in year_xml_diffs.items()
            ]) if year_xml_diffs else pd.DataFrame([])

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
        return self.df1.loc[self.add_ids] if self.add_ids else pd.DataFrame([])

    @cached_property
    def del_ids(self) -> list[str]:
        return list(self.ids0.difference(self.ids1))

    @cached_property
    def preserved_ids(self) -> list[str]:
        return list(self.ids0.intersection(self.ids1))

    @cached_property
    def changed_crashes(self) -> pd.DataFrame:
        preserved_ids = self.preserved_ids
        if not preserved_ids:
            return pd.DataFrame([])
        b0 = self.df0.loc[preserved_ids].sort_index().fillna('')
        b1 = self.df1.loc[preserved_ids].sort_index().fillna('')
        if len(b0.columns) != len(b1.columns):
            raise RuntimeError(f"{self.commit.hexsha[:SHORT_SHA_LEN]}: column count mismatch, {len(b0.columns)} vs. {len(b1.columns)}")
        if (b0.columns != b1.columns).any():
            if set(b0.columns.tolist()) != set(b1.columns.tolist()):
                raise RuntimeError(f"{self.commit.hexsha[:SHORT_SHA_LEN]}: column name mismatch, {b0.columns} vs. {b1.columns}")
            b0 = b0[b1.columns]
        changed_rows = (b0 != b1).any(axis=1)
        changed_sxs = pd.concat([ b0[changed_rows], b1[changed_rows], ], axis=1)
        columns = [
            (idx, col)
            for idx in [ 0, 1 ]
            for col in b1.columns
        ]
        changed_sxs.columns = pd.MultiIndex.from_tuples(columns)
        return changed_sxs

    @cached_property
    def updated_ids(self) -> list[str]:
        return self.changed_crashes.index.tolist()

    @property
    def updated_df(self) -> pd.DataFrame:
        return self.df1.loc[self.updated_ids] if self.updated_ids else pd.DataFrame([])

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

    def descriptions(self, dst: Dst = 'slack', **kwargs) -> list[str]:
        new_df = self.adds_df
        descriptions = new_df.apply(crash_str, dst=dst, **kwargs, axis=1)
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
