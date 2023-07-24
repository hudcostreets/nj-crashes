from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from os.path import exists
from typing import Optional

import click
from utz import cached_property

from njsp.commit_crashes import REPO


def get_xml_path(year: int) -> str:
    return f'data/FAUQStats{year}.xml'


class SourcemapParser(HTMLParser):
    @staticmethod
    def load(path: str) -> dict:
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

    def __init__(self, start_year: int = START, end_year: int = None):
        year = start_year
        accid_map = {}
        while True:
            if year == end_year:
                break
            xml_path = get_xml_path(year)
            if not exists(xml_path):
                now = datetime.now()
                if year > now.year:
                    break
                else:
                    raise RuntimeError(f"Couldn't find {xml_path}")

            year_accid_map = SourcemapParser.load(xml_path)
            extant_keys = set(accid_map).intersection(set(year_accid_map))
            if extant_keys:
                raise RuntimeError(f"ACCIDs would be overwritten by year {year}: {list(extant_keys)}")
            accid_map.update(year_accid_map)
            year += 1
        self.accid_map = accid_map


@dataclass
class Crash:
    accid: str

    _crashes: Optional[Crashes] = None

    @cached_property
    def crashes(self) -> Crashes:
        if not self._crashes:
            self._crashes = Crashes()
        return self._crashes

    def xml_url(self, ref: Optional[str] = None):
        accid_map = self.crashes.accid_map
        rng = accid_map[self.accid]
        (start_line, _), (end_line, _) = rng['start'], rng['end']
        path = rng['path']
        ref = ref or 'main'
        return f'https://github.com/{REPO}/blob/{ref}/{path}#L{start_line}-L{end_line}'


@click.command()
@click.option('-n', '--max-num', type=int, default=0)
@click.option('-s', '--start-year', type=int, default=Crashes.START)
def main(max_num, start_year):
    accid_map = Crashes(start_year=start_year).accid_map


if __name__ == '__main__':
    main()
