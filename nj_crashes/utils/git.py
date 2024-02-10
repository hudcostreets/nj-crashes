from typing import Optional

from git import Repo
from utz import process, err


_repo: Optional[Repo] = None


def get_repo() -> Repo:
    global _repo
    if _repo is None:
        _repo = Repo()
    return _repo


SHORT_SHA_LEN = 8


def git_fmt(*refs: str, fmt: str = '%h', log: bool = True, **kwargs) -> str:
    return process.line('git', 'log', '-1', f'--format={fmt}', *refs, log=err if log is True else log, **kwargs)


