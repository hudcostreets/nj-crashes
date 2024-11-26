from os.path import exists, relpath, join
from re import fullmatch

import click
import pandas as pd
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from github import UnknownObjectException
from html.parser import HTMLParser
from typing import Optional
from utz import err

from nj_crashes import ROOT_DIR
from nj_crashes.utils import git
from nj_crashes.utils.git import git_fmt
from nj_crashes.utils.github import load_github
from njsp.commit_crashes import REPO
from njsp.paths import OLD_CRASHES_RELPATH, CRASHES_RELPATH, CRASHES_PQT, CRASHES_PQT_S3


def get_xml_path(year: int) -> str:
    return f'data/FAUQStats{year}.xml'


RELPATHS = [ CRASHES_RELPATH, OLD_CRASHES_RELPATH ]
blob_from_commit = partial(git.blob_from_commit, relpaths=RELPATHS)


def load() -> pd.DataFrame:
    if exists(CRASHES_PQT):
        return pd.read_parquet(CRASHES_PQT)
    else:
        return pd.read_parquet(CRASHES_PQT_S3)


class SourcemapParser(HTMLParser):
    @staticmethod
    def load(path: str, xml: str = None) -> dict:
        if not xml:
            with open(path, 'r') as f:
                xml = f.read()
        parser = SourcemapParser(path=path)
        parser.feed(xml)
        return parser.accid_map

    def __init__(self, path: str, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = path
        self.accid_map = {}
        self.accid = None

    def handle_starttag(self, tag: str, attrs):
        super().handle_starttag(tag, attrs)
        if tag == 'accident':
            # print(f'<{tag}>: {attrs}')
            accid = dict(attrs)['accid']
            self.accid = accid
            self.accid_map[accid] = { 'path': self.path, 'start': self.getpos() }

    def handle_endtag(self, tag: str):
        super().handle_endtag(tag)
        if tag == 'accident':
            # print(f'</{tag}> ({self.accid})')
            self.accid_map[self.accid]['end'] = self.getpos()
            self.accid = None


class Crashes:
    START = 2008

    def __init__(self, ref: str, start_year: int = START, end_year: int = None):
        self.ref = ref
        self.start_year = start_year
        year = start_year
        accid_map = {}
        while True:
            if year == end_year:
                break
            xml_path = get_xml_path(year)
            xml_abspath = relpath(join(ROOT_DIR, xml_path))
            if not exists(xml_abspath):
                now = datetime.now()
                if year > now.year:
                    break
                else:
                    raise RuntimeError(f"Couldn't find {xml_path}")

            try:
                xml = load_github(path=xml_path, ref=ref).decode()
                year_accid_map = SourcemapParser.load(xml_path, xml=xml)
                extant_keys = set(accid_map).intersection(set(year_accid_map))
                if extant_keys:
                    raise RuntimeError(f"ACCIDs would be overwritten by year {year}: {list(extant_keys)}")
                accid_map.update(year_accid_map)
            except UnknownObjectException as e:
                err(f"{year}: missing XML file {xml_path}@{ref}: {e}")
            year += 1

        self.end_year = year
        self.accid_map = accid_map


_all_crashes: dict[str, Crashes] = {}


@dataclass
class Crash:
    accid: str

    @staticmethod
    def crashes(ref: str) -> Crashes:
        if ref not in _all_crashes:
            _all_crashes[ref] = Crashes(ref=ref)
        return _all_crashes[ref]

    def xml_url(self, ref: Optional[str] = None):
        if not ref:
            ref = git_fmt(fmt='%H')
        if not fullmatch(r'[\da-f]+', ref):
            ref = git_fmt(ref, fmt='%H')
        accid_map = self.crashes(ref=ref).accid_map
        rng = accid_map[self.accid]
        (start_line, _), (end_line, _) = rng['start'], rng['end']
        path = rng['path']
        return f'https://github.com/{REPO}/blob/{ref}/{path}#L{start_line}-L{end_line}'


@click.command()
@click.option('-n', '--max-num', type=int, default=0)
@click.option('-s', '--start-year', type=int, default=Crashes.START)
def main(max_num, start_year):
    accid_map = Crashes(start_year=start_year).accid_map


if __name__ == '__main__':
    main()
