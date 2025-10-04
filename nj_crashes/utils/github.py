from functools import cached_property

from dataclasses import dataclass

from base64 import b64decode
from os import environ
from re import fullmatch
from subprocess import CalledProcessError

import git
from github import Auth, Github
from github.Commit import Commit
from github.GitTree import GitTree
from github.Repository import Repository
from io import BytesIO
from os.path import exists, expanduser
import pandas as pd
from utz import proc

from nj_crashes.utils.git import git_fmt
from njdot.rawdata.utils import singleton

REPO = 'hudcostreets/nj-crashes'
_gh: Github | None = None
_gh_repo: Repository | None = None


def expand_ref(ref: str) -> str:
    if fullmatch(r'^[0-9a-f]{40}$', ref):
        return ref
    else:
        try:
            return git_fmt(ref, fmt='%H')
        except CalledProcessError:
            gh = get_github_repo()
            return gh.get_commit(ref).sha


def expand_refspec(refspec: str, *args: str) -> list[str]:
    pcs = refspec.split('..')
    if len(pcs) == 2:
        cmd = [ 'git', 'log', '--format=%H', f'{pcs[0]}..{pcs[1]}' ]
        if args:
            cmd += [ '--', *args ]
        return proc.lines(cmd)
    elif len(pcs) == 1:
        return [expand_ref(pcs[0])]
    else:
        raise ValueError(f"Invalid refspec {refspec=}")


def get_github_repo() -> Repository:
    global _gh
    global _gh_repo
    if _gh is None:
        GITHUB_TOKEN = environ.get('GITHUB_TOKEN') or environ.get('GH_TOKEN')
        if not GITHUB_TOKEN:
            for github_token_path in [ '.github_token', '.gh_token', '~/.github_token', '~/.gh_token' ]:
                if exists(expanduser(github_token_path)):
                    with open(github_token_path, 'r') as f:
                        GITHUB_TOKEN = f.read()
                        break
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
    ref: str | None = None,
    repo: Repository | None = None,
) -> bytes:
    if repo is None:
        repo = get_github_repo()
    return repo.get_contents(path, ref=ref).decoded_content


def load_pqt_github(
        path: str,
        ref: str = None,
        repo: Repository | None = None,
) -> pd.DataFrame:
    content_bytes = load_github(path, ref, repo)
    return pd.read_parquet(BytesIO(content_bytes))


@dataclass
class GithubBlob:
    """Partial implementation of git.Blob interface for GitHub blobs."""
    name: str
    hexsha: str

    @property
    def data_stream(self):
        gh = get_github_repo()
        blob = gh.get_git_blob(self.hexsha)
        return BytesIO(b64decode(blob.content))
        # return BytesIO(process.output('gh', 'api', '-H', 'Accept: application/vnd.github.raw+json', f'/repos/{REPO}/git/blobs/{self.hexsha}'))
        # TODO: streaming response
        # gh_token = environ['GH_TOKEN']
        # headers = {
        #     'Accept': 'application/vnd.github.raw+json',
        #     'Authorization': f'Bearer {gh_token}',
        # }
        # return BytesIO(requests.get(self.blob.url, headers=headers).content)


@dataclass
class GithubTree:
    """Partial implementation of git.Tree interface for GitHub trees."""
    tree: GitTree

    @staticmethod
    def from_commit(commit: Commit) -> 'GithubTree':
        gh = get_github_repo()
        tree = gh.get_git_tree(commit.raw_data['commit']['tree']['sha'])
        return GithubTree(tree)

    @staticmethod
    def from_sha(sha: str) -> 'GithubTree':
        gh = get_github_repo()
        return GithubTree(gh.get_git_tree(sha))

    @cached_property
    def raw_data(self):
        tree = self.tree
        raw_data = tree.raw_data
        if raw_data['truncated']:
            raise RuntimeError(f"Tree {tree.sha} is truncated")
        return tree.raw_data

    def __contains__(self, item):
        return any(e['path'] == item for e in self.children)

    @property
    def hexsha(self):
        return self.raw_data['sha']

    @property
    def children(self):
        return self.raw_data['tree']

    def __getitem__(self, key) -> 'Object':
        [ child, *descendants ] = key.split('/', 1)
        child = singleton([ c for c in self.children if c['path'] == child ])
        if not child:
            raise KeyError(f"Tree {self.hexsha}: child not found: {child}")
        elif descendants:
            rest = singleton(descendants)
            return GithubTree(child)[rest]
        else:
            kind = child['type']
            if kind == 'blob':
                return GithubBlob(name=child['path'], hexsha=child['sha'])
            elif kind == 'tree':
                return GithubTree.from_sha(child['sha'])
            return child

    @property
    def blobs(self):
        return [
            GithubBlob(name=e['path'], hexsha=e['sha'])
            for e in self.children if e['type'] == 'blob'
        ]

    @property
    def trees(self):
        gh = get_github_repo()
        return [
            GithubTree(gh.get_git_tree(e['sha']))
            for e in self.children if e['type'] == 'tree'
        ]


Object = GithubBlob | GithubTree


@dataclass
class GithubCommit:
    commit: Commit

    @staticmethod
    def from_git(git_commit: git.Commit) -> 'GithubCommit':
        gh = get_github_repo()
        return GithubCommit(gh.get_commit(git_commit.hexsha))

    @staticmethod
    def from_sha(sha: str) -> 'GithubCommit':
        gh = get_github_repo()
        return GithubCommit(gh.get_commit(sha))

    @property
    def raw_data(self):
        return self.commit.raw_data

    @property
    def hexsha(self):
        return self.raw_data['sha']

    @property
    def raw_commit(self):
        return self.raw_data['commit']

    @property
    def tree_sha(self) -> str:
        return self.raw_commit['tree']['sha']

    @property
    def parents(self) -> list['GithubCommit']:
        gh = get_github_repo()
        return [
            GithubCommit(gh.get_commit(p['sha']))
            for p in self.raw_data['parents']
        ]

    @property
    def authored_datetime(self) -> str:
        return self.raw_commit['author']['date']

    @property
    def parent(self) -> 'GithubCommit':
        return singleton(self.parents)

    @cached_property
    def tree(self) -> GithubTree:
        gh = get_github_repo()
        tree = gh.get_git_tree(self.tree_sha)
        return GithubTree(tree)



Blob = git.Blob | GithubBlob
