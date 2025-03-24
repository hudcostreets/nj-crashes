from dataclasses import dataclass
from typing import Union

from pandas import Timestamp


@dataclass
class Add(Crash):
    sha: str
    rundate: Timestamp


@dataclass
class Update(Crash):
    sha: str
    rundate: Timestamp


@dataclass
class Rm:
    sha: str
    rundate: Timestamp


CrashVersion = Union[Add, Update, Rm]


@dataclass
class CrashLog:
    accid: int
    versions: list[CrashVersion]

    @property
    def cur(self) -> CrashVersion:
        return self.versions[-1]
