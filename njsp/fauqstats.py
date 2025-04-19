from __future__ import annotations

import pandas as pd
import re
from dataclasses import dataclass
from git import Commit, Tree
from typing import IO

import git

from nj_crashes.utils import TZ
from nj_crashes.utils.github import Blob, GithubBlob, GithubCommit, GithubTree
from bs4 import BeautifulSoup as bs

from nj_crashes.utils.log import Log, err


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
            fauqstats = get_fauqstats(obj.data_stream)
        else:
            blob_sha = None
            fauqstats = get_fauqstats(obj)
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
            crashes['dt'] = (
                crashes[['DATE', 'TIME']]
                .apply(
                    lambda r: (
                        pd.to_datetime(f'{r["DATE"]} {r["TIME"]}')
                        .tz_localize(TZ)
                    ),
                    axis=1
                )
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
