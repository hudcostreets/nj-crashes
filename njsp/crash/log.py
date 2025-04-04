from abc import ABC
from dataclasses import dataclass
from hashlib import sha256

from pandas import Timestamp, Series, DataFrame
from utz import call

from nj_crashes.utils.github import REPO
from njsp.crash.crash import Crash
from njsp.crashes import Crashes


class Version(ABC):
    accid: int
    sha: str
    rundate: Timestamp

    @staticmethod
    def load(r: Series) -> 'Version':
        cls = {
            'add': Add,
            'update': Update,
            'del': Delete,
        }[r.kind]
        return call(cls, **r)
        # kind = r.kind
        # if kind == 'add':
        #     return call(Add, **r)
        # elif kind == 'update':
        #     return call(Update, **r)
        # elif kind == 'del':
        #     return call(Delete, **r)
        # else:
        #     raise ValueError(f"Invalid crash version kind: {kind}")

    line_range_side = "R"

    @property
    def _xml_url_commit(self) -> str:
        return self.sha

    def xml_url(self, ref: str | None = None):
        sha = self.sha
        if ref and ref != sha:
            raise ValueError(f"{ref=} != {sha=}")
        commit = self._xml_url_commit
        accid_map = Crashes(ref=commit).accid_map
        rng = accid_map[str(self.accid)]  #
        (start_line, _), (end_line, _) = rng['start'], rng['end']
        path = rng['path']
        hsh = sha256()
        hsh.update(path.encode())
        path_sha256 = hsh.hexdigest()
        side = self.line_range_side
        line_range = f"{side}{start_line}-{side}{end_line}"
        return f'https://github.com/{REPO}/commit/{sha}#diff-{path_sha256}{line_range}'

    # def to_str(
    #     r,
    #     fmt: Fmt = '%a %b %-d %Y %-I:%M%p',
    #     github_url: str | None = None,
    #     dst: Dst = 'slack',
    # ) -> str:
    #     victim_str = r.victim_str
    #     dt_str = mk_dt_str(r['dt'], fmt)
    #     if isna(r.LOCATION):
    #         location = 'unknown location'
    #     else:
    #         location = r.LOCATION.replace('&', '&amp;')
    #
    #     def link(uri: str, text: str) -> str:
    #         nonlocal dst
    #         if dst == 'slack':
    #             return f'<{uri}|{text}>'
    #         else:
    #             return f'[{text}]({uri})'
    #
    #     if github_url:
    #         gh_link = link(github_url, str(r.accid))
    #     else:
    #         gh_link = f'{r.accid}'
    #
    #     c_url, m_url = r.urls
    #     c_link = link(uri=c_url, text=f'{r.CNAME} County')
    #     m_link = link(uri=m_url, text=r.MNAME)
    #     return f'*{dt_str} ({gh_link})*: {m_link} ({c_link}), {location}: {victim_str} deceased'


@dataclass
class Add(Version, Crash):
    sha: str
    rundate: Timestamp


@dataclass
class Update(Version, Crash):
    sha: str
    rundate: Timestamp


@dataclass
class Delete(Version):
    sha: str
    rundate: Timestamp
    accid: int

    line_range_side = "L"

    @property
    def _xml_url_commit(self) -> str:
        return f"{self.sha}^"


def versions(df: DataFrame) -> list[Version]:
    return [
        Version.load(r)
        for _, r in df.iterrows()
    ]


@dataclass
class Log:
    accid: int
    versions: list[Version]

    @staticmethod
    def load(df: DataFrame, accid: int) -> 'Log':
        return Log(
            accid=accid,
            versions=versions(df.loc[accid].reset_index()),
        )

    @property
    def cur(self) -> Version:
        return self.versions[-1]
