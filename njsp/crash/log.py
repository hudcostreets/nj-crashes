from abc import ABC
from dataclasses import dataclass

from pandas import Timestamp, Series, DataFrame

from njsp.crash.crash import Crash


class Version(ABC):
    sha: str
    rundate: Timestamp

    @staticmethod
    def load(r: Series) -> 'Version':
        kind = r.kind
        if kind == 'add':
            return Add(**{**r, 'accid': int(r.name)})
        elif kind == 'update':
            return Update(**{**r, 'accid': int(r.name)})
        elif kind == 'del':
            return Delete(sha=r.sha, rundate=Timestamp(r.rundate))
        else:
            raise ValueError(f"Invalid crash version kind: {kind}")


@dataclass
class Add(Crash, Version):
    sha: str
    rundate: Timestamp


@dataclass
class Update(Crash, Version):
    sha: str
    rundate: Timestamp


@dataclass
class Delete(Version):
    sha: str
    rundate: Timestamp


@dataclass
class Log:
    accid: int
    versions: list[Version]

    @staticmethod
    def load(df: DataFrame, accid: int) -> 'Log':
        versions = [
            Version.load(r)
            for _, r in df.loc[accid].reset_index().iterrows()
        ]
        return Log(accid=accid, versions=versions)

    @property
    def cur(self) -> Version:
        return self.versions[-1]
