from __future__ import annotations

from abc import ABC
from dataclasses import dataclass
from hashlib import sha256

from pandas import Timestamp, Series, DataFrame, isna
from utz import call

from nj_crashes.utils.github import REPO
from nj_crashes.utils.log import err
from njsp.crash.crash import Crash
from njsp.crashes import Crashes, CHILD_TAGS, ATTRS


class Version(ABC):
    accid: int
    sha: str
    rundate: Timestamp

    @staticmethod
    def load(r: Series, prev: 'Version | None') -> 'Version':
        if r.kind == 'add':
            assert prev is None or isinstance(prev, Delete), f"{r}, {prev}"
            return call(Add, **r, prev=prev)
        elif r.kind == 'update':
            assert isinstance(prev, (Add, Update)), f"{r}, {prev}"
            return call(Update, **r, prev=prev)
        elif r.kind == 'del':
            assert isinstance(prev, (Add, Update)), f"{r}, {prev}"
            return call(Delete, **r, prev=prev)
        else:
            raise ValueError(f"Invalid {r.kind=}: {r}")

    line_range_side = "R"

    @property
    def is_noop(self) -> bool:
        return False

    @property
    def _xml_url_commit(self) -> str:
        return self.sha

    def xml_url(self, ref: str | None = None):
        """Generate a URL to the XML line range corresponding to this crash-record deletion, in GitHub's commit-diff
        view.

        Unfortunately, GitHub's web UI doesn't always correctly scroll to the given line range, on page load, but
        instead drops the user at the top of the relevant XML file's diffs. If the user scrolls to the line range in
        question, it will be highlighted, but overall it's not a great experience. Hopefully GitHub will fix this,
        because the commit-diff view is a much better representation of what changed in this ``Version`` than linking to
        the ``/blob`` view (as ``Crash`` does).

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
        if isinstance(self, Update):
            prev = self.prev
            diff_field_linenos = []
            if not prev:
                raise ValueError(f'Update requires prev: {self}')
            child_pos_map = rng['children']
            for attr in ATTRS:
                if getattr(prev, attr, None) != getattr(self, attr, None):
                    diff_field_linenos.append(start_line)
            for tag in CHILD_TAGS:
                v0 = getattr(prev, tag, None)
                v1 = getattr(self, tag, None)
                if v0 != v1 and not (tag == 'INJURIES' and isna(v0) and isna(v1)):
                    if tag in ['HIGHWAY', 'STREET', 'LOCATION'] and tag not in child_pos_map:
                        err(f"{tag} was removed, starting range from {start_line=}")
                        diff_field_linenos.append(start_line)
                    else:
                        diff_field_linenos.append(child_pos_map[tag][0])
            start_line = min(diff_field_linenos)
            end_line = max(diff_field_linenos)
        line_range = f"{side}{start_line}-{side}{end_line}"
        return f'https://github.com/{REPO}/commit/{sha}?diff=split#diff-{path_sha256}{line_range}'

    def slack_update_str(v, idx: int, n: int) -> str:
        xml_url = v.xml_url(ref=v.sha)
        rundate_str = v.rundate.strftime('%Y%m%d')
        if isinstance(v, Add):
            slack_str = v.slack_str(github_url=xml_url)
            if idx == 0:
                if n == 1:
                    return slack_str
                else:
                    return f"Added ({rundate_str}):\n&gt; {slack_str}"
            else:
                return f"Re-added ({rundate_str}):\n&gt; {slack_str}"
        elif isinstance(v, Update):
            slack_str = v.slack_str(github_url=xml_url)
            return f"Updated ({rundate_str}):\n&gt; {slack_str}"
        elif isinstance(v, Delete):
            slack_str = v.prev.slack_str(github_url=xml_url)
            return f"Deleted ({rundate_str}):\n&gt; {slack_str}"
        else:
            raise ValueError(f"Invalid version type {v=}")



@dataclass
class Add(Version, Crash):
    sha: str
    rundate: Timestamp
    prev: Delete | None


@dataclass
class Update(Version, Crash):
    sha: str
    rundate: Timestamp
    prev: Add | Update

    def updates(self):
        d0 = { k: getattr(self.prev, k, None) for k in CHILD_TAGS.union(ATTRS) }
        d1 = { k: getattr(self, k, None) for k in CHILD_TAGS.union(ATTRS) }
        adds = { k: v for k, v in d1.items() if k not in d0 }
        dels = { k: v for k, v in d0.items() if k not in d1 }
        both = { k: (d0[k], d1[k]) for k in d0 if k in d1 and d0[k] != d1[k] }
        return dict(adds=adds, dels=dels, both=both)

    @property
    def is_noop(self) -> bool:
        updates = self.updates()
        if not updates['adds'] and not updates['dels']:
            updates = updates['both']
            if len(updates) == 1 and 'INJURIES' in updates:
                i0, i1 = updates['INJURIES']
                if isna(i0):
                    i0 = 0
                if isna(i1):
                    i1 = 0
                if i0 == i1 and i0 == 0:
                    return True
        return False


@dataclass
class Delete(Version):
    sha: str
    rundate: Timestamp
    accid: int
    prev: Add | Update

    line_range_side = "L"

    @property
    def _xml_url_commit(self) -> str:
        return f"{self.sha}^"


def versions(df: DataFrame) -> list[Version]:
    prev = None
    rv = []
    for _, r in df.iterrows():
        v = Version.load(r, prev=prev)
        rv.append(v)
        prev = v
    return rv


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
