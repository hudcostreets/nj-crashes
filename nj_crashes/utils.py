from base64 import b64decode

from io import BytesIO

import re
import utz

from dataclasses import dataclass
import git
from git import Commit, Tree
from github.Commit import Commit as GithubCommit

from typing import IO, Union, Callable

from IPython.core.display import Image
from bs4 import BeautifulSoup as bs
import pandas as pd
from utz import singleton, process

from njsp.commit_crashes import REPO, get_github_repo


def get_children(tag):
    return [ child for child in tag.children if not isinstance(child, str) ]


def get_fauqstats(path: Union[str, IO]):
    if isinstance(path, str):
        with open(path, 'r') as f:
            xml = bs(f, features="xml")
    else:
        xml = bs(path, features="xml")
    children = list(xml.children)
    assert len(children) == 2
    fauqstats = children[-1]
    return fauqstats


Log = Callable[[str], None]


def none(msg: str):
    pass


def err(msg):
    utz.err(str(msg))


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


fauqstats_cache = {}


@dataclass
class FAUQStats:
    year: int
    rundate: str
    crashes: pd.DataFrame
    totals: pd.DataFrame

    @classmethod
    def blobs(cls, obj: Union[Commit, Tree, GithubCommit]) -> dict[int, Blob]:
        if isinstance(obj, GithubCommit):
            children = obj.commit.tree.tree
            data = singleton([ e for e in children if e.path == 'data' ])
            data_sha = data.sha
            gh = get_github_repo()
            data = gh.get_git_tree(data_sha)
            children = data.raw_data['tree']
            # tree_resp = process.json('gh', 'api', f'/repos/{REPO}/git/trees/{data_sha}')
            # children = tree_resp['tree']
            blobs = [ GithubBlob(name=e['path'], hexsha=e['sha']) for e in children if e['type'] == 'blob' ]
        else:
            if isinstance(obj, Commit):
                tree = obj.tree
            else:
                tree = obj
            data = tree['data']
            blobs = data.blobs

        fauqstats_blobs = {}
        for blob in blobs:
            m = re.fullmatch(r'FAUQStats(?P<year>20\d\d)\.xml', blob.name)
            if not m:
                continue
            year = int(m['year'])
            fauqstats_blobs[year] = blob
        return fauqstats_blobs

    @classmethod
    def load(cls, obj: Union[str, Blob], log: Log = err) -> 'FAUQStats':
        if isinstance(obj, Blob):
            blob_sha = obj.hexsha
            if blob_sha in fauqstats_cache:
                fauqstats = fauqstats_cache[blob_sha]
                log(f"FAUQStats cache hit: {fauqstats.year}, {fauqstats.rundate}")
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
            crashes['dt'] = crashes[['DATE', 'TIME']].apply(lambda r: pd.to_datetime(f'{r["DATE"]} {r["TIME"]}'), axis=1)
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
            log(f"FAUQStats cache miss: {fauqstats.year}, {fauqstats.rundate}")
            fauqstats_cache[blob_sha] = fauqstats
        return fauqstats


def normalized_ytd_days(dt):
    """Combine 2/29 and 2/28, count YTD days as if in non-leap years."""
    days = int((dt - pd.to_datetime(f'{dt.year}').tz_localize(dt.tz)).days + 1)
    if dt.year % 4 == 0 and dt.month >= 3:
        days -= 1
    return days


interactive = False
def show(fig, i=False, w=1000, h=600):
    global interactive
    return fig if interactive or i else Image(fig.to_image(width=w, height=h))
