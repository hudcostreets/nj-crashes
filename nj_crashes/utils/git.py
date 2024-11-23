from typing import Optional, Union

from git import Repo, Commit
from utz import process, err

from nj_crashes import ROOT_DIR

_repo: Optional[Repo] = None


def get_repo() -> Repo:
    global _repo
    if _repo is None:
        _repo = Repo(ROOT_DIR)
    return _repo


SHORT_SHA_LEN = 8


def git_fmt(*refs: str, fmt: str = '%h', log: bool = True, **kwargs) -> str:
    return process.line('git', 'log', '-1', f'--format={fmt}', *refs, log=err if log is True else log, **kwargs)


def blob_from_commit(commit: Commit, relpaths: Union[str, list[str]]):
    tree = commit.tree
    if isinstance(relpaths, str):
        relpaths = [relpaths]
    for relpath in relpaths:
        try:
            return tree[relpath]
        except KeyError:
            pass
    short_sha = commit.hexsha[:SHORT_SHA_LEN]
    raise RuntimeError(f"Commit {short_sha}: no relpath found, checked {', '.join(relpaths)}")
