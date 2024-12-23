#!/usr/bin/env python
from os import makedirs
from os.path import exists, dirname, splitext

import click
import json
import pandas as pd
import re
import requests
import shutil
import sys
import time
import utz
from click import option
from functools import partial
from numpy import nan
from tabula import read_pdf
from utz import err
from zipfile import ZipFile

from njdot.paths import DOT_DATA
from njdot.data import COUNTIES, YEARS, FIELDS_DIR, END_YEAR, START_YEAR, REGIONS
from njdot.opts import parse_opt
from njdot.tbls import parse_type, TYPE_TO_FIELDS, types_opt

# Download datasets from https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm
# The download action on that page doesn't seem to work, but we can access the data directly at URLs like
# "https://www.state.nj.us/transportation/refdata/accident/2020/Burlington2020Accidents.zip".

DEFAULT_CACHE_PATH = f'{DOT_DATA}/.cache.pqt'
CACHE_HEADERS = [ 'Date', 'Content-Length', 'Content-type', 'Last-modified', 'Etag', ]


def maybe_capemay_space(county, year):
    if county == 'CapeMay' and year in { '2001', '2002', '2003', '2020', }:
        return 'Cape May'
    else:
        return county


@click.group()
def cli():
    pass


overwrite_opt = option('-f', '--overwrite', is_flag=True, help="Overwrite the output file, if it exists (default: no-op/skip)")
dry_run_opt = option('-n', '--dry-run', is_flag=True, help="Print conversions that would be performed, don't perform them")


def is_subsequence(ss, s):
    if not ss:
        return True
    if not s:
        return False
    [ ch, *ss ] = ss
    idx = s.find(ch)
    if idx < 0:
        return False
    return is_subsequence(ss, s[(idx+1):])


singleton = partial(utz.singleton, empty_ok=True, dedupe=False)


def parse_region(region_str):
    region_str = region_str.lower()

    # Exact match check
    region = singleton(REGIONS, lambda r: r.lower() == region_str)
    if region:
        return region

    # Prefix check
    region = singleton(REGIONS, lambda r: r.lower().startswith(region_str))
    if region:
        return region

    # Substring check
    region = singleton(REGIONS, lambda r: region_str in r.lower())
    if region:
        return region

    # Subsequence check
    region = singleton(REGIONS, lambda r: is_subsequence(region_str, r.lower()))
    if region:
        return region
    else:
        raise ValueError(f"Unrecognized region str {region_str}")


def parse_regions(regions_str):
    if not regions_str:
        return REGIONS
    return [ parse_region(region_str) for region_str in regions_str.split(',') ]


regions_opt = parse_opt(
    '-r', '--regions',
    parse=parse_regions, kw='regions',
    help=f"Comma-separated list of regions (counties or \"NewJersey\": {', '.join(REGIONS)}); unique prefixes, substrings, and subsequences also supported",
)


def parse_years(years_str) -> list[int]:
    if not years_str:
        return YEARS
    all_years = []
    for years in years_str.split(','):
        pcs = years.split('-')
        if len(pcs) == 1:
            all_years += pcs
        elif len(pcs) == 2:
            start, end = pcs
            start = int(start) if start else START_YEAR
            end = int(end) if end else END_YEAR
            all_years += list(range(start, end))
        else:
            raise ValueError(f"Unrecognized year piece {years} in {years_str}")
    return list(sorted(list(map(int, set(all_years)))))


years_opt = parse_opt(
    '-y', '--years',
    parse=parse_years,
    kw='years',
    help=f"Comma-separated list of years (supported range: [{START_YEAR}, {END_YEAR})); ranges also supported, e.g. \"2002-2010\", \"-2010\", \"2017-\"",
)


def cmd(*opts, help=None):
    def wrapper(fn):
        decos = (
            cli.command(fn.__name__, short_help=help),
            regions_opt,
            types_opt,
            years_opt,
        ) + opts
        for deco in reversed(decos):
            fn = deco(fn)

        return fn

    return wrapper


def dry_run_skip(in_path, out_path, dry_run, overwrite):
    if exists(out_path):
        if overwrite:
            if dry_run:
                err(f'DRY RUN: would convert (overwrite) {in_path} → {out_path}')
            else:
                err(f'Converting (overwriting) {in_path} → {out_path}')
        else:
            err(f'{out_path} exists; skipping')
            return True
    else:
        if dry_run:
            err(f'DRY RUN: would convert {in_path} → {out_path}')
        else:
            err(f'Converting {in_path} → {out_path}')
    return dry_run


@cmd(
    option('-C', '--cache-path', default=DEFAULT_CACHE_PATH),
    option('-f', '--force', count=True),
    option('-s', '--sleep', type=float, default=0.2),
    help='Download 1 or more {year, county} .zip file(s)'
)
def zip(regions, cache_path, force, sleep, types, years):
    cache = pd.read_parquet(cache_path) if exists(cache_path) else None
    updated_paths = []
    try:
        for region in regions:
            for year in years:
                url_county = maybe_capemay_space(region, year)
                for typ in types:
                    name = f'{year}/{region}{year}{typ}.zip'
                    url_name = f'{year}/{url_county}{year}{typ}.zip'
                    url = f'https://www.state.nj.us/transportation/refdata/accident/{url_name}'
                    out_path = f'{DOT_DATA}/{name}'
                    if exists(out_path):
                        if force:
                            print(f'{url}: force-checking HEAD for extant zip {name}')
                        else:
                            print(f'{url}: skipping, {name} exists')
                            continue
                    head = requests.head(url, allow_redirects=True)
                    try:
                        head.raise_for_status()
                    except Exception:
                        raise RuntimeError(f"Failed HEAD for {url}")
                    cache_headers = { k: head.headers[k] for k in CACHE_HEADERS }
                    new_row = { 'url': url, **cache_headers }
                    new_row_df = pd.DataFrame([ new_row ]).set_index('url')

                    def download():
                        r = requests.get(url)
                        r.raise_for_status()
                        makedirs(dirname(out_path), exist_ok=True)
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
    overwrite_opt,
    dry_run_opt,
    help='Convert 1 or more {year, county} .zip files (convert each .zip to a single .txt)'
)
def txt(regions, types, years, overwrite, dry_run):
    for region in regions:
        for year in years:
            for typ in types:
                parent_dir = f'{DOT_DATA}/{year}'
                # table = TABLE_TYPES_MAP[typ]
                table = typ
                name = f'{parent_dir}/{region}{year}{table}'
                zip_path = f'{name}.zip'
                txt_path = f'{name}.txt'
                if dry_run_skip(zip_path, txt_path, dry_run=dry_run, overwrite=overwrite):
                    continue

                with ZipFile(zip_path, 'r') as zip_ref:
                    namelist = zip_ref.namelist()
                    txt_name = f'{region}{year}{table}.txt'
                    mv = False
                    if txt_name not in namelist:
                        if region == 'CapeMay':
                            txt_name = f'Cape May{year}{table}.txt'
                            mv = True
                            if txt_name not in namelist:
                                raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                        else:
                            raise RuntimeError(f"{zip_path}: {txt_name} not found in namelist {namelist}\n")
                    if namelist != [ txt_name ]:
                        err(f"{zip_path}: unexpected namelist {namelist}")
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


@cli.command('parse-fields-pdf', short_help="Parse fields+lengths from one or more schema PDFs, using Tabula")
@option('-2', '--2017', 'version2017', count=True, help='One or more year-versions to process: 0x: 2001, 1x: 2017, 2x: [2001, 2017]')
@overwrite_opt
@dry_run_opt
@types_opt
def parse_fields_pdf(version2017, overwrite, dry_run, type_strs):
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
            if dry_run_skip(pdf_path, json_path, dry_run=dry_run, overwrite=overwrite):
                continue

            tbls = read_pdf(pdf_path, area=[ rect[k] for k in [ 'y1', 'x1', 'y2', 'x2', ] ], pages='all',)
            fields = pd.concat(tbls).to_dict('records')
            with open(json_path, 'w') as f:
                json.dump(fields, f, indent=4)


D4 = re.compile(r'\d{4}')
D2 = re.compile(r'\d\d')
D1 = re.compile(r'\d')
D1_2 = re.compile(r'(?P<h>\d) (?P<mm>\d\d)')


def build_dt(r):
    crash_date = r['Crash Date']
    crash_time = r['Crash Time']
    date_str = crash_date
    time_str = None
    if crash_time:
        if D4.fullmatch(crash_time):
            time_str = f'{crash_time}'
        elif D2.fullmatch(crash_time):
            if crash_time != "00":
                time_str = f'{crash_time}00'
        elif D1.fullmatch(crash_time):
            if crash_time != "0":
                time_str = f'0{crash_time}00'
        elif m := D1_2.fullmatch(crash_time):
            time_str = f"0{m['h']}{m['mm']}"

    if time_str:
        dt_str = f'{date_str} {time_str}'
    else:
        dt_str = date_str
        if crash_time:
            err(f'Dropping unrecognized "Crash Time": "{crash_time}"')

    return pd.to_datetime(dt_str)


BOOLS = { 'Y': True, 'N': False, '1': True, '0': False, '': False }


def load(txt_path, fields, ints=None, floats=None, bools=None):
    df = parse_rows(txt_path, fields)
    for k in ints or []:
        df[k] = df[k].astype(int)
    for k in floats or []:
        df[k] = df[k].replace('', nan).astype(float)
    for k in bools or []:
        df[k] = df[k].apply(lambda s: BOOLS[s]).astype(bool)
    return df


def get_2021_dob_fix_fields(fields, dob_col):
    """Driver DOB is missing from 2021Drivers (similarly "Date of Birth" in 2021Pedestrians)."""
    new_fields = []
    pos = 1
    dob_field = None
    for f in fields:
        if f['Field'] == dob_col:
            dob_field = { **f }
        else:
            length = f['Length']
            new_field = { **f, 'From': pos, 'To': pos + length - 1, }
            pos += length
            new_fields.append(new_field)
    if not dob_field:
        raise RuntimeError(f"Couldn't find '{dob_col}' field in {fields}")
    err(f"Moved '{dob_col}' to end of fields")
    dob_field['From'] = pos
    dob_field['To'] = pos + dob_field['Length'] - 1
    new_fields.append(dob_field)
    return new_fields


@cmd(
    overwrite_opt,
    dry_run_opt,
    help='Convert 1 or more unzipped {year, county} `.txt` files to `.pqt`s, with some dtypes and cleanup'
)
def pqt(regions, types, years, overwrite, dry_run):
    fields_dict = {}
    for year in years:
        # Load `fields` dict for `year`
        v2017 = year >= 2017
        for region in regions:
            for typ in types:
                parent_dir = f'{DOT_DATA}/{year}'
                table = TYPE_TO_FIELDS[typ]
                name = f'{parent_dir}/{region}{year}{typ}'
                txt_path = f'{name}.txt'
                pqt_path = f'{name}.pqt'
                json_name = f'{2017 if v2017 else 2001}{table}Table.json'
                json_path = f'{FIELDS_DIR}/{json_name}'
                if json_path in fields_dict:
                    fields = fields_dict[json_path]
                else:
                    with open(json_path, 'r') as f:
                        fields = json.load(f)
                        fields_dict[json_path] = fields
                    if typ == 'Crash' and year == '2013' and region == 'Atlantic':
                        # For some reason, "Reporting Badge No." in Atlantic2013[Accidents] is 18 chars long, not 5
                        [ *fields, rest ] = fields
                        fields = [ *fields, { **rest, 'Length': 18 } ]
                        err(f'{pqt_path}: overwrote final field length to 18 (was: {rest})')
                if dry_run_skip(txt_path, pqt_path, dry_run=dry_run, overwrite=overwrite):
                    continue

                if typ == 'Accidents':
                    df = load(
                        txt_path, fields,
                        ints=[ 'Total Killed', 'Total Injured', 'Pedestrians Killed', 'Pedestrians Injured', 'Total Vehicles Involved', ],
                        floats=[ 'Latitude', 'Longitude', ('MilePost' if v2017 else 'Mile Post')],
                        bools=[ 'Alcohol Involved', 'HazMat Involved', ],
                    )
                    df['Date'] = df.apply(build_dt, axis=1)
                    df = df.drop(columns=['Year', 'Crash Time', 'Crash Date', 'Crash Day Of Week'])
                    if v2017:
                        df = df.rename(columns={
                            'Police Dept Code': 'Police Department Code',
                            'MilePost': 'Mile Post',
                            'SRI (Std Rte Identifier)': 'SRI (Standard Route Identifier)',
                            'Directn From Cross Street': 'Direction From Cross Street',
                        })
                        if year >= 2021:
                            df['County Name'] = df['County Name'].str.upper().str.replace('CAPEMAY', 'CAPE MAY')
                elif typ == 'Vehicles':
                    df = load(txt_path, fields, bools=[ 'Hit & Run Driver Flag', ])
                    if not v2017:
                        df = df.rename(columns={
                            'Pre- Crash Action': 'Pre-Crash Action',
                        })
                elif typ == 'Pedestrians':
                    if year >= 2021:
                        new_fields = get_2021_dob_fix_fields(fields, 'Date of Birth')
                    else:
                        new_fields = fields
                    df = load(txt_path, new_fields, bools=[ 'Is Bycyclist?', 'Is Other?', ]).rename(columns={'Is Bycyclist?': 'Is Bicyclist?'})
                    if v2017:
                        df = df.rename(columns={
                            'Type of Most Severe Phys Injury': 'Type of Most Severe Physical Injury',
                        })
                    else:
                        df = df.rename(columns={
                            'Charge': 'Charge 1',
                            'Summons': 'Summons 1',
                            'Physical Status': 'Physical Status 1',
                            'Pre- Crash Action': 'Pre-Crash Action',
                        })
                elif typ == 'Drivers':
                    if year >= 2021:
                        new_fields = get_2021_dob_fix_fields(fields, 'Driver DOB')
                    else:
                        new_fields = fields
                    df = load(txt_path, new_fields)
                    if not v2017:
                        df = df.rename(columns={
                            'Charge': 'Charge 1',
                            'Summons': 'Summons 1',
                            'Driver Physical Status': 'Driver Physical Status 1',
                        })
                elif typ == 'Occupants':
                    df = load(txt_path, fields)
                    if v2017:
                        df = df.rename(columns={
                            'Type of Most Severe Phys Injury': 'Type of Most Severe Physical Injury',
                        })
                else:
                    raise ValueError(f"Unrecognized type {typ}")

                err(f'Writing {pqt_path}')
                df.to_parquet(pqt_path, index=None)


@cli.command('check-nj-agg', short_help='For one or more years, verify the `NewJersey` file is a concatenation of the county-specific files')
@option('-y', '--year', 'years')
def check_nj_agg(years):
    years = map(int, years.split(',')) if years else YEARS
    for year in years:
        nj = pd.read_parquet(f'{DOT_DATA}/{year}/NewJersey{year}Accidents.pqt')
        cs = pd.concat([
            pd.read_parquet(f'{year}/{county}{year}Accidents.pqt')
            for county in COUNTIES
        ])

        errors = []
        def error(msg):
            nonlocal errors
            err(f'{year}: {msg}')
            errors.append(msg)

        if len(nj) != len(cs):
            error(f'{len(nj)} NJ, {len(cs)} counties')
        combined = pd.concat([ nj, cs ])

        nj_cs_isdup = combined.duplicated(keep='first')
        nj_cs_isdup1, nj_cs_isdup2 = nj_cs_isdup.iloc[:len(nj)], nj_cs_isdup.iloc[len(nj):]
        if nj_cs_isdup1.any():
            intra_nj_dups = nj[nj_cs_isdup1]
            error(f'{len(intra_nj_dups)} intra-NJ dupes:\n{intra_nj_dups}')
        if not nj_cs_isdup2.all():
            cs_only = cs[~nj_cs_isdup2]
            error(f'{len(cs_only)} counties-only rows:\n{cs_only}')

        cs_nj_isdup = combined.duplicated(keep='last')
        cs_nj_isdup1, cs_nj_isdup2 = cs_nj_isdup.iloc[:len(nj)], cs_nj_isdup.iloc[len(nj):]
        if cs_nj_isdup2.any():
            intra_cs_dups = cs[cs_nj_isdup2]
            error(f'{len(intra_cs_dups)} intra-county dupes:\n{intra_cs_dups}')
        if not cs_nj_isdup1.all():
            nj_only = nj[~cs_nj_isdup1]
            error(f'{len(nj_only)} NJ-only rows:\n{nj_only}')

        if errors:
            sys.exit(1)
        else:
            print(f'{year}: {len(nj)} NJ records match {len(cs)} county-level records')


if __name__ == '__main__':
    cli()
