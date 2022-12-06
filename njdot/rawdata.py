#!/usr/bin/env python
import time
from os import makedirs
from os.path import exists, dirname, splitext, basename
from zipfile import ZipFile

import click
import pandas as pd
import requests
from requests import HTTPError

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

@click.command()
@click.option('-c', '--counties')
@click.option('-C', '--cache-path', default=DEFAULT_CACHE_PATH)
@click.option('-s', '--sleep', type=int, default=0.2)
@click.option('-t', '--types')
@click.option('-y', '--years')
def main(counties, cache_path, sleep, types, years):
    counties = counties.split(',') if counties else COUNTIES
    years = years.split(',') if years else YEARS
    types = types.split(',') if types else TYPES
    cache = pd.read_parquet(cache_path) if exists(cache_path) else None
    updated_paths = []
    downloaded_paths = []
    try:
        for county in counties:
            for year in years:
                for typ in types:
                    name = f'{year}/{county}{year}{typ}.zip'
                    url = f'https://www.state.nj.us/transportation/refdata/accident/{name}'
                    out_path = name
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
                        downloaded_paths.append(out_path)

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
    except HTTPError as e:
        if updated_paths:
            print(f'Writing cache ({len(cache)} rows)')
            cache.to_parquet(cache_path)
        raise

    for zip_path in updated_paths:
        parent_dir = dirname(zip_path)
        txt_path = f'{splitext(zip_path)[0]}.txt'
        if not exists(txt_path) or zip_path in downloaded_paths:
            with ZipFile(zip_path, 'r') as zip_ref:
                namelist = zip_ref.namelist()
                if namelist != [ basename(txt_path) ]:
                    raise RuntimeError(f"{zip_path}: unexpected namelist {namelist}")
                print(f'Extracting: {zip_path} → {txt_path}')
                zip_ref.extractall(parent_dir)


if __name__ == '__main__':
    main()
