#!/usr/bin/env python
from os import makedirs
from os.path import exists, dirname, splitext

import click
import json
import pandas as pd
import requests
import shutil
import sys
import time
from click import option
from numpy import nan
from re import fullmatch
from sys import stderr
from tabula import read_pdf
from zipfile import ZipFile

# Download datasets from https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm
# The download action on that page doesn't seem to work, but we can access the data directly at URLs like
# "https://www.state.nj.us/transportation/refdata/accident/2020/Burlington2020Accidents.zip".

COUNTIES = [
    'NewJersey',
    'Atlantic',
    'Bergen',
    'Burlington',
    'Camden',
    'CapeMay',
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

YEARS = list(map(str, range(2001, 2021)))

TYPES = [
    "Accidents",
    "Drivers",
    "Vehicles",
    "Occupants",
    "Pedestrians",
]


DATA_DIR = 'data'
FIELDS_DIR = f'{DATA_DIR}/fields'
DEFAULT_CACHE_PATH = f'{DATA_DIR}/.cache.pqt'
CACHE_HEADERS = [ 'Date', 'Content-Length', 'Content-type', 'Last-modified', 'Etag', ]


def maybe_capemay_space(county, year):
    if county == 'CapeMay' and year in { '2001', '2002', '2003', '2020', }:
        return 'Cape May'
    else:
        return county


@click.group()
def cli():
    pass


def cmd(*opts, help=None):
    def wrapper(fn):
        def _fn(counties, types, years, *args, **kwargs):
            counties = counties.split(',') if counties else COUNTIES
            years = years.split(',') if years else YEARS
            types = types.split(',') if types else TYPES
            return fn(*args, counties=counties, types=types, years=years, **kwargs)

        decos = (
            cli.command(fn.__name__, short_help=help),
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
    option('-s', '--sleep', type=float, default=0.2),
    help='Download 1 or more {year, county} .zip file(s)'
)
def zip(counties, cache_path, force, sleep, types, years):
    cache = pd.read_parquet(cache_path) if exists(cache_path) else None
    updated_paths = []
    try:
        for county in counties:
            for year in years:
                url_county = maybe_capemay_space(county, year)
                for typ in types:
                    name = f'{year}/{county}{year}{typ}.zip'
                    url_name = f'{year}/{url_county}{year}{typ}.zip'
                    url = f'https://www.state.nj.us/transportation/refdata/accident/{url_name}'
                    out_path = f'{DATA_DIR}/{name}'
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
                        with open(out_path, 'wb') as f:
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
                        if force == 2:
                            print(f'{url} downloading (forced)')
                        else:
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
    help='Convert 1 or more {year, county} .zip files (convert each .zip to a single .txt)'
)
def txt(counties, types, years, overwrite):
    for county in counties:
        for year in years:
            for typ in types:
                parent_dir = f'{DATA_DIR}/{year}'
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
                    txt_name = f'{county}{year}{typ}.txt'
                    mv = False
                    if txt_name not in namelist:
                        if county == 'CapeMay':
                            txt_name = f'Cape May{year}{typ}.txt'
                            mv = True
                            if txt_name not in namelist:
                                raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                        else:
                            raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                    if namelist != [ txt_name ]:
                        stderr.write(f"{zip_path}: unexpected namelist {namelist}\n")
                    print(f'Extracting: {zip_path} → {txt_path}')
                    zip_ref.extract(txt_name, parent_dir)
                    if mv:
                        src = f'{parent_dir}/{txt_name}'
                        print(f'Fixing "Cape ?May" path: {src} → {txt_path}')
                        shutil.move(src, txt_path)


def parse_row(f, idx, fields):
    row = {}
    for fidx, field in enumerate(fields):
        fname, flen = field['Field'], field['Length']
        fval = f.read(flen)
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
        raise RuntimeError(f'Row {idx}: expected newline at position {f.tell()}, found "{last}", row {row}')
    return row


def parse_rows(txt_path, fields):
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
    return pd.DataFrame(rows)


TABLE_TYPES = ['Crash', 'Driver', 'Occupant', 'Pedestrian', 'Vehicle', ]
TABLE_TYPES_MAP = {
    **{ t.lower(): t for t in TABLE_TYPES },
    **{ t.lower()[0]: t for t in TABLE_TYPES },
}
TABLE_TYPE_KEYS = list(TABLE_TYPES_MAP.keys())


def parse_type(type_str):
    if type_str not in TABLE_TYPES_MAP:
        raise ValueError(f"Unrecognized type {type_str}; expected one of {TABLE_TYPE_KEYS}")
    return TABLE_TYPES_MAP[type_str]


@cli.command('parse-fields-pdf', short_help="Parse fields+lengths from one or more schema PDFs, using Tabula")
@option('-2', '--2017', 'version2017', count=True, help='One or more year-versions to process: 0x: 2001, 1x: 2017, 2x: [2001, 2017]')
@option('-f', '--overwrite', is_flag=True, help="Overwrite the output json file, if it exists (default: no-op/skip)")
@option('-t', '--type', 'type_strs', help=f"Comma-separated list of table types ({TABLE_TYPE_KEYS})")
def parse_fields_pdf(version2017, overwrite, type_strs):
    types = [ parse_type(type_str) for type_str in type_strs.split(',') ]
    if version2017 == 0:
        versions = [ 2001 ]
    elif version2017 == 1:
        versions = [ 2017 ]
    else:
        versions = [ 2001, 2017 ]

    for tpe in types:
        for version in versions:
            if version == 2017:
                rect = {
                    "x1": 27.54,
                    "x2": 586,
                    "y1": 91.4175,
                    "y2": 750.0825,
                }
                pdf_name = f'2017{tpe}Table.pdf'
            else:
                rect = {
                    "x1": 25.6275,
                    "x2": 587.1375,
                    "y1": 81.4725,
                    "y2": 750.0825,
                }
                pdf_name = f'2001{tpe}Table.pdf'

            pdf_path = f'{FIELDS_DIR}/{pdf_name}'
            json_path = f'{splitext(pdf_path)[0]}.json'
            if exists(json_path):
                if overwrite:
                    stderr.write(f'Converting (overwriting) {pdf_path} to {json_path}\n')
                else:
                    stderr.write(f'Found {json_path}; skipping\n')
                    continue
            else:
                stderr.write(f'Converting {pdf_path} to {json_path}\n')

            tbls = read_pdf(pdf_path, area=[ rect[k] for k in [ 'y1', 'x1', 'y2', 'x2', ] ], pages='all',)
            fields = pd.concat(tbls).to_dict('records')
            with open(json_path, 'w') as f:
                json.dump(fields, f, indent=4)


def build_dt(r):
    crash_time = r['Crash Time']
    if crash_time and not fullmatch(r'\d{4}', crash_time):
        stderr.write(f'Dropping unrecognized "Crash Time": "{crash_time}"\n')
        return pd.to_datetime(r['Crash Date'])
    else:
        return pd.to_datetime(r['Crash Date'] + ' ' + crash_time)


@cmd(
    option('-f', '--overwrite', is_flag=True),
    help='Convert 1 or more unzipped {year, county} `.txt` files to `.pqt`s, with some dtypes and cleanup'
)
def pqt(counties, types, years, overwrite):
    fields_dict = {}
    for year in years:
        # Load `fields` dict for `year`
        v2017 = int(year) >= 2017
        for county in counties:
            if v2017 in fields_dict:
                fields = fields_dict[v2017]
            else:
                json_name = f'{2017 if v2017 else 2001}CrashTable.json'
                json_path = f'{FIELDS_DIR}/{json_name}'
                with open(json_path, 'r') as f:
                    fields = json.load(f)
                    fields_dict[v2017] = fields
                if year == '2013' and county == 'Atlantic':
                    # For some reason, "Reporting Badge No." in Atlantic2013[Accidents…?] is 18 chars long, not 5
                    fields[-1]['Length'] = 18

            for typ in types:
                parent_dir = f'{DATA_DIR}/{year}'
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
                df = parse_rows(txt_path, fields)

                ints = [ 'Total Killed', 'Total Injured', 'Pedestrians Killed', 'Pedestrians Injured', 'Total Vehicles Involved', ]
                floats = [ 'Latitude', 'Longitude', ('MilePost' if v2017 else 'Mile Post')]
                bools = [ 'Alcohol Involved', 'HazMat Involved', ]

                df['Date'] = df.apply(build_dt, axis=1)
                df = df.drop(columns=['Year', 'Crash Time', 'Crash Date', 'Crash Day Of Week'])

                for k in floats:
                    df[k] = df[k].replace('', nan).astype(float)

                for k in bools:
                    df[k] = df[k].replace('Y', True).replace('N', False).astype(bool)

                df = df.astype(dict(**{ k: int for k in ints },))

                print(f'Writing {pqt_path}')
                df.to_parquet(pqt_path, index=None)


@cli.command('check-nj-agg', short_help='For one or more years, verify the `NewJersey` file is a concatenation of the county-specific files')
@option('-y', '--year', 'years')
def check_nj_agg(years):
    years = years.split(',') if years else YEARS
    for year in years:
        nj = pd.read_parquet(f'{DATA_DIR}/{year}/NewJersey{year}Accidents.pqt')
        counties = COUNTIES[1:]
        cs = pd.concat([
            pd.read_parquet(f'{year}/{county}{year}Accidents.pqt')
            for county in counties
        ])

        errors = []
        def err(msg):
            nonlocal errors
            stderr.write(f'{year}: {msg}\n')
            errors.append(msg)

        if len(nj) != len(cs):
            err(f'{len(nj)} NJ, {len(cs)} counties')
        combined = pd.concat([ nj, cs ])

        nj_cs_isdup = combined.duplicated(keep='first')
        nj_cs_isdup1, nj_cs_isdup2 = nj_cs_isdup.iloc[:len(nj)], nj_cs_isdup.iloc[len(nj):]
        if nj_cs_isdup1.any():
            intra_nj_dups = nj[nj_cs_isdup1]
            err(f'{len(intra_nj_dups)} intra-NJ dupes:\n{intra_nj_dups}')
        if not nj_cs_isdup2.all():
            cs_only = cs[~nj_cs_isdup2]
            err(f'{len(cs_only)} counties-only rows:\n{cs_only}')

        cs_nj_isdup = combined.duplicated(keep='last')
        cs_nj_isdup1, cs_nj_isdup2 = cs_nj_isdup.iloc[:len(nj)], cs_nj_isdup.iloc[len(nj):]
        if cs_nj_isdup2.any():
            intra_cs_dups = cs[cs_nj_isdup2]
            err(f'{len(intra_cs_dups)} intra-county dupes:\n{intra_cs_dups}')
        if not cs_nj_isdup1.all():
            nj_only = nj[~cs_nj_isdup1]
            err(f'{len(nj_only)} NJ-only rows:\n{nj_only}')

        if errors:
            sys.exit(1)
        else:
            print(f'{year}: {len(nj)} NJ records match {len(cs)} county-level records')


if __name__ == '__main__':
    cli()
