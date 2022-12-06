#!/usr/bin/env python
import time
from os import makedirs
from os.path import exists, dirname, splitext, basename
from zipfile import ZipFile

import click
import pandas as pd
import requests
from click import option
from requests import HTTPError
from tabula import read_pdf

# Download datasets from https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm
# The download action on that page doesn't seem to work, but we can access the data directly at URLs like
# "https://www.state.nj.us/transportation/refdata/accident/2020/Burlington2020Accidents.zip".

COUNTIES = [
    'NewJersey',
    'Atlantic',
    'Bergen',
    'Burlington',
    'Camden',
    # 'CapeMay',
    'Cumberland',
    'Essex',
    'Gloucester',
    'Hudson',
    'Hunterdon',
    'Mercer',
    'Middlesex',
    'Monmouth',
    'Morris',
    'Ocean',
    'Passaic',
    'Salem',
    'Somerset',
    'Sussex',
    'Union',
    'Warren',
]

YEARS = list(range(2001, 2021))

TYPES = [
    "Accidents",
    "Drivers",
    "Vehicles",
    "Occupants",
    "Pedestrians",
]


DEFAULT_CACHE_PATH = '.cache.pqt'
CACHE_HEADERS = [ 'Date', 'Content-Length', 'Content-type', 'Last-modified', 'Etag', ]


@click.group()
def cli():
    pass


def cmd(*opts):
    def wrapper(fn):
        def _fn(counties, types, years, *args, **kwargs):
            counties = counties.split(',') if counties else COUNTIES
            years = years.split(',') if years else YEARS
            types = types.split(',') if types else TYPES
            return fn(*args, counties=counties, types=types, years=years, **kwargs)

        decos = (
            cli.command(fn.__name__),
            click.option('-c', '--counties'),
            click.option('-t', '--types'),
            click.option('-y', '--years'),
        ) + opts
        for deco in reversed(decos):
            _fn = deco(_fn)

        return _fn

    return wrapper


@cmd(
    option('-C', '--cache-path', default=DEFAULT_CACHE_PATH),
    option('-f', '--force', count=True),
    option('-s', '--sleep', type=int, default=0.2),
)
def zip(counties, cache_path, force, sleep, types, years):
    cache = pd.read_parquet(cache_path) if exists(cache_path) else None
    updated_paths = []
    try:
        for county in counties:
            for year in years:
                for typ in types:
                    name = f'{year}/{county}{year}{typ}.zip'
                    url = f'https://www.state.nj.us/transportation/refdata/accident/{name}'
                    out_path = name
                    if exists(out_path):
                        if force:
                            print(f'{url}: force-checking HEAD for extant zip {name}')
                        else:
                            print(f'{url}: skipping, {name} exists')
                            continue
                    head = requests.head(url)
                    head.raise_for_status()
                    cache_headers = { k: head.headers[k] for k in CACHE_HEADERS }
                    new_row = { 'url': url, **cache_headers }
                    new_row_df = pd.DataFrame([ new_row ]).set_index('url')

                    def download():
                        r = requests.get(url)
                        r.raise_for_status()
                        makedirs(dirname(name), exist_ok=True)
                        with open(name, 'wb') as f:
                            f.write(r.content)

                    needs_download = True
                    if cache is not None and url in cache.index:
                        cur_row = cache.loc[url]
                        cur_row_headers = cur_row.to_dict()
                        header_diffs = {}
                        for k in CACHE_HEADERS:
                            cur = cur_row_headers[k]
                            new = new_row[k]
                            if cur != new:
                                header_diffs[k] = [ cur, new ]
                        if header_diffs:
                            print(f'{url} new headers: {", ".join([ f"{k}: {cur} → {new}" for k, [ cur, new ] in header_diffs.items() ])}')
                            if list(header_diffs.keys()) != [ 'Date' ]:
                                print(f'{url} downloading (updated headers)')
                                download()
                            elif force == 2:
                                print(f'{url} forced re-download')
                            else:
                                needs_download = False
                            cache = pd.concat([ cache.drop(url), new_row_df])
                            updated_paths.append(out_path)
                        else:
                            print(f'{url} cache hit')
                            needs_download = False

                    if needs_download:
                        print(f'{url} downloading (cache miss)')
                        download()
                        cache = pd.concat([ cache, new_row_df])
                        updated_paths.append(out_path)

                if sleep:
                    time.sleep(sleep)
    finally:
        if updated_paths:
            print(f'Writing cache ({len(cache)} rows)')
            cache.to_parquet(cache_path)


@cmd(
    option('-f', '--overwrite', is_flag=True),
)
def txt(counties, types, years, overwrite):
    for county in counties:
        for year in years:
            for typ in types:
                parent_dir = f'{year}'
                name = f'{parent_dir}/{county}{year}{typ}'
                zip_path = f'{name}.zip'
                txt_path = f'{name}.txt'
                if exists(txt_path):
                    if overwrite:
                        print(f'{txt_path}: overwriting ')
                    else:
                        print(f'{txt_path} exists; skipping')
                        continue

                with ZipFile(zip_path, 'r') as zip_ref:
                    namelist = zip_ref.namelist()
                    if namelist != [ basename(txt_path) ]:
                        raise RuntimeError(f"{zip_path}: unexpected namelist {namelist}")
                    print(f'Extracting: {zip_path} → {txt_path}')
                    zip_ref.extractall(parent_dir)


def parse_row(f, idx, fields):
    row = {}
    for fidx, field in enumerate(fields):
        fname, flen = field['Field'], field['Length']
        fval = f.read(flen)
        # try:
        #     fval = fvalb.decode('utf-8')
        # except UnicodeDecodeError as e:
        #     print(f'{e}: {fvalb}')
        #     fval = '???'
        #     raise RuntimeError(f'row {idx} fidx {fidx} {fname} ({flen}), empty read. {row}')
        if not fval:
            if fidx:
                raise RuntimeError(f'row {idx} fidx {fidx} {fname} ({flen}), empty read. {row}')
            else:
                return None
        fval = fval.strip()
        if fname != 'Comma':
            row[fname] = fval
    last = f.read(1)
    if last != '\n':
        raise RuntimeError(f'Row {idx}: expected newline, found "{last}", row {row}')
    return row


@cmd(
    option('-f', '--overwrite', is_flag=True),
)
def pqt(counties, types, years, overwrite):
    rect = {
        "x1": 43.222500000000004,
        "x2": 564.1875,
        "y1": 91.4175,
        "y2": 750.0825,
    }
    pdf = '2017CrashTable.pdf'
    tbls = read_pdf(pdf, area=[ rect[k] for k in [ 'y1', 'x1', 'y2', 'x2', ] ], pages='all',)
    fields = pd.concat(tbls)
    fields = fields.to_dict('records')
    for county in counties:
        for year in years:
            for typ in types:
                parent_dir = f'{year}'
                name = f'{parent_dir}/{county}{year}{typ}'
                txt_path = f'{name}.txt'
                pqt_path = f'{name}.pqt'
                if exists(pqt_path):
                    if overwrite:
                        print(f'{pqt_path}: overwriting ')
                    else:
                        print(f'{pqt_path} exists; skipping')
                        continue

                print(f'Parsing {txt_path}')
                rows = []
                idx = 0
                with open(txt_path, 'r', encoding='ISO-8859-1') as f:
                    while True:
                        row = parse_row(f, idx=idx, fields=fields)
                        if row:
                            rows.append(row)
                            idx += 1
                        else:
                            break

                df = pd.DataFrame(rows)
                print(f'Writing {pqt_path}')
                df.to_parquet(pqt_path, index=None)


if __name__ == '__main__':
    cli()
