from __future__ import annotations

import pandas as pd
import re
from dataclasses import dataclass
from git import Commit, Tree
from io import BytesIO
from typing import IO

import git

from nj_crashes.utils import TZ
from nj_crashes.utils.github import Blob, GithubBlob, GithubCommit, GithubTree
from bs4 import BeautifulSoup as bs

from nj_crashes.utils.log import Log, err, none


def get_fauqstats(path: str | IO):
    if isinstance(path, str):
        with open(path, 'r') as f:
            xml = bs(f, features="xml")
    else:
        xml = bs(path, features="xml")
    children = list(xml.children)
    assert len(children) == 2
    fauqstats = children[-1]
    return fauqstats


def get_children(tag):
    return [ child for child in tag.children if not isinstance(child, str) ]


fauqstats_cache = {}


def _parse_blob(sha: str, data: bytes) -> tuple[str, 'FAUQStats']:
    return sha, FAUQStats.parse_bytes(data, sha, none)


@dataclass
class FAUQStats:
    year: int
    rundate: str
    crashes: pd.DataFrame
    totals: pd.DataFrame

    @classmethod
    def blobs(cls, obj: Commit | Tree | GithubTree | GithubCommit) -> dict[int, Blob]:
        if isinstance(obj, (Commit, GithubCommit)):
            tree = obj.tree
        else:
            tree = obj
        data = tree['data']
        blobs = data.blobs

        fauqstats_blobs = {}
        for blob in blobs:
            if not (m := re.fullmatch(r'FAUQStats(?P<year>20\d\d)\.xml', blob.name)):
                continue
            year = int(m['year'])
            fauqstats_blobs[year] = blob
        return fauqstats_blobs

    @classmethod
    def load(cls, obj: str | Blob, log: Log = err) -> 'FAUQStats':
        if isinstance(obj, (git.Blob, GithubBlob)):
            blob_sha = obj.hexsha
            if blob_sha in fauqstats_cache:
                fauqstats = fauqstats_cache[blob_sha]
                log(f"{blob_sha}: FAUQStats cache hit: {fauqstats.year}, {fauqstats.rundate}")
                return fauqstats
            return cls._from_soup(get_fauqstats(obj.data_stream), blob_sha, log)
        return cls._from_soup(get_fauqstats(obj), None, log)

    @classmethod
    def parse_bytes(cls, data: bytes, blob_sha: str, log: Log = err) -> 'FAUQStats':
        """Parse raw XML bytes into a cached FAUQStats (for parallel prewarm)."""
        if blob_sha in fauqstats_cache:
            return fauqstats_cache[blob_sha]
        return cls._from_soup(get_fauqstats(BytesIO(data)), blob_sha, log)

    # Below this many uncached blobs, a process pool costs more (startup + pickle)
    # than it saves — the daily's incremental runs touch only a handful, so parse
    # them in-process. Full-history reprocs (thousands of blobs) cross it and fan out.
    PREWARM_MIN = 64

    @classmethod
    def prewarm(cls, blobs: dict[str, bytes], n_jobs: int | None = None, log: Log = err) -> int:
        """Populate `fauqstats_cache` by parsing `blobs` (sha -> raw XML) up front.

        bs4 tree construction is GIL-bound (threads measured *slower*), so this fans
        out across *processes* (loky) — the one path that actually parallelizes the
        parse (~2.4x measured). Workers return parsed objects; the parent owns the
        cache. Purely an optimization: a missed/failed blob falls through to an
        on-demand parse in the walk. Small inputs parse in-process (see PREWARM_MIN)."""
        todo = [(sha, data) for sha, data in blobs.items() if sha not in fauqstats_cache]
        if not todo:
            return 0
        if len(todo) < cls.PREWARM_MIN:
            for sha, data in todo:
                cls.parse_bytes(data, sha, none)
        else:
            from joblib import Parallel, delayed
            for sha, fx in Parallel(n_jobs=n_jobs or -1, backend='loky')(
                delayed(_parse_blob)(sha, data) for sha, data in todo
            ):
                fauqstats_cache[sha] = fx
        log(f"FAUQStats.prewarm: parsed {len(todo)} unique blobs")
        return len(todo)

    @classmethod
    def _from_soup(cls, fauqstats, blob_sha: str | None, log: Log = err) -> 'FAUQStats':
        assert fauqstats.name == 'FAUQSTATS', fauqstats.name
        rundate = fauqstats.RUNDATE.text
        year = int(fauqstats.STATSYEAR.text)
        counties = fauqstats.find_all('COUNTY', recursive=False)
        total_accidents = int(fauqstats.TOTACCIDENTS.text)
        total_injuries = int(fauqstats.TOTINJURIES.text)
        total_fatalities = int(fauqstats.TOTFATALITIES.text)
        crash_counties = [ county for county in counties if county.MUNICIPALITY ]
        # log(f'{len(counties)} "COUNTY" entries, {len(crash_counties)} containing "MUNICIPALITY"/crash info, {total_accidents} accidents, {total_injuries} injuries, {total_fatalities} fatalities')
        records = []
        for county in crash_counties:
            municipalities = county.find_all('MUNICIPALITY')
            for municipality in municipalities:
                assert municipality.name == 'MUNICIPALITY'
                children = get_children(municipality)
                accidents = municipality.find_all('ACCIDENT', recursive=False)
                if len(children) != len(accidents):
                    raise ValueError(f'Found {len(children)} municipality children, but {len(accidents)} accidents: {county}. {accidents}')
                for accident in accidents:
                    obj = { child.name: child.text for child in get_children(accident) }
                    obj = dict(**county.attrs, **municipality.attrs, **accident.attrs, **obj, )
                    records.append(obj)

        crashes = pd.DataFrame(records)
        if 'DATE' in crashes:
            # Vectorized: one `to_datetime` over the whole column instead of a
            # per-row `.apply` (which called `pd.to_datetime` once per accident —
            # ~22s of a 120-commit `crash_log` build, profiled). `.sort_values('dt')`
            # below makes row order independent of parse order, so this is identical.
            # `format='mixed'` infers the format *per element* (like the old per-row
            # code) rather than locking the whole column to the first element's
            # inferred format — NJSP's `DATE`/`TIME` strings vary enough across years
            # (e.g. `10/27/2023 0114`) that a single inferred format misparses others
            # into `OutOfBoundsDatetime`.
            crashes['dt'] = (
                pd.to_datetime(crashes['DATE'] + ' ' + crashes['TIME'], format='mixed')
                .dt.tz_localize(TZ)
            )
            float_cols = [
                'FATALITIES',
                'FATAL_D',
                'FATAL_P',
                'FATAL_T',
                'FATAL_B',
                'INJURIES',
            ]
            dtypes = {
                col: float
                for col in float_cols
                if col in crashes
            }
            crashes = (
                crashes
                .astype(dtypes)
                .drop(columns=['DATE', 'TIME'])
                .set_index('ACCID')
                .sort_values('dt')
            )
        else:
            # e.g. loading an XML from the start of a year, when there's no crashes yet that year
            # crashes['dt'] = Series([], dtype='datetime64[ns]')
            pass

        totals_df = pd.DataFrame([dict(
            year=year,
            accidents=total_accidents,
            injuries=total_injuries,
            fatalities=total_fatalities,
        )])
        fauqstats = FAUQStats(year=year, rundate=rundate, crashes=crashes, totals=totals_df)
        if blob_sha:
            log(f"{blob_sha}: FAUQStats cache miss: {fauqstats.year}, {fauqstats.rundate}")
            fauqstats_cache[blob_sha] = fauqstats
        return fauqstats
