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

    line_range_side = "R"

    @property
    def _xml_url_commit(self) -> str:
        return self.sha


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

    def xml_url(self, ref: str | None = None):
        """Generate a URL to the XML line range corresponding to this crash-record deletion, in GitHub's commit-diff
        view.

        ``Add``s and ``Update``s inherit this method from ``Crash``, which links to the XML line-range corresponding to
        the crash, at the given SHA (``/blob/<SHA>/<path>#L<start>-L<end>``). In the case of a ``Delete``, however, the
        crash no longer exists in the XML, so we link to the line range in the commit's "diff" view
        (``/commit/<SHA>#diff-<path_sha256><line_range>``).

        Unfortunately, GitHub's web UI doesn't correctly scroll to the given line range, on page load, but instead drops
        the user at the top of the relevant XML file. If the user scrolls to the line range in question, it will be
        highlighted, but overall it's not a great experience.

        TODO: file issue vs. GitHub about commit-diff-line-range links not loading properly.
        """
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
