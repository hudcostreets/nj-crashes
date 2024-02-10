from dataclasses import dataclass

from base64 import b64decode
from os import environ

import git
from io import BytesIO
from os.path import exists

from github import Auth, Github
from github.Repository import Repository

from typing import Optional, Union

import pandas as pd


REPO = 'neighbor-ryan/nj-crashes'
_gh: Optional[Github] = None
_gh_repo: Optional[Repository] = None


def get_github_repo() -> Repository:
    global _gh
    global _gh_repo
    if _gh is None:
        GITHUB_TOKEN = environ.get('GITHUB_TOKEN')
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


Blob = Union[git.Blob, GithubBlob]
