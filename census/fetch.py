"""Fetch NJ population data from the Census API.

Caches each (vintage, level) response as JSON under `census/data/raw/`.
Without --refresh, cached files are reused and only missing vintages hit the API.

Endpoints:
- ACS 5-year `B01003_001E` (total population), end-year vintages 2009-2023:
    /data/{year}/acs/acs5?get=NAME,B01003_001E&for=state:34
    /data/{year}/acs/acs5?get=NAME,B01003_001E&for=county:*&in=state:34
    /data/{year}/acs/acs5?get=NAME,B01003_001E&for=county+subdivision:*&in=state:34+county:*
- Decennial 2000 SF1 `P001001` at cousub level (one-shot):
    /data/2000/dec/sf1?get=NAME,P001001&for=county+subdivision:*&in=state:34+county:*

Auth: register at https://api.census.gov/data/key_signup.html and set
$CENSUS_API_KEY (or pass --api-key). Without a key the API rate-limits to
~500 req/day/IP.
"""
import json
import os
from os import makedirs
from os.path import exists, join
from time import sleep

import requests
from click import command, option

from nj_crashes.utils.log import err
from census import (
    ACS5_FIRST_YEAR, ACS5_LAST_YEAR, NJ_STATE_FIPS, POP_VAR_ACS, POP_VAR_DEC2000, RAW_DIR,
)

API_BASE = 'https://api.census.gov/data'


def cache_path(name: str) -> str:
    return join(RAW_DIR, f'{name}.json')


def fetch(url: str, params: dict, api_key: str | None) -> list[list[str]]:
    if api_key:
        params = {**params, 'key': api_key}
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_cached(name: str, url: str, params: dict, api_key: str | None, refresh: bool) -> list[list[str]]:
    path = cache_path(name)
    if exists(path) and not refresh:
        with open(path) as f:
            return json.load(f)
    err(f'fetch {name}: {url}')
    data = fetch(url, params, api_key)
    makedirs(RAW_DIR, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=0)
        f.write('\n')
    return data


def fetch_acs5_state(year: int, api_key: str | None, refresh: bool):
    url = f'{API_BASE}/{year}/acs/acs5'
    params = {'get': f'NAME,{POP_VAR_ACS}', 'for': f'state:{NJ_STATE_FIPS}'}
    return fetch_cached(f'acs5_{year}_state', url, params, api_key, refresh)


def fetch_acs5_county(year: int, api_key: str | None, refresh: bool):
    url = f'{API_BASE}/{year}/acs/acs5'
    params = {'get': f'NAME,{POP_VAR_ACS}', 'for': 'county:*', 'in': f'state:{NJ_STATE_FIPS}'}
    return fetch_cached(f'acs5_{year}_county', url, params, api_key, refresh)


def fetch_acs5_cousub(year: int, api_key: str | None, refresh: bool):
    url = f'{API_BASE}/{year}/acs/acs5'
    params = {'get': f'NAME,{POP_VAR_ACS}', 'for': 'county subdivision:*', 'in': f'state:{NJ_STATE_FIPS} county:*'}
    return fetch_cached(f'acs5_{year}_cousub', url, params, api_key, refresh)


def fetch_dec2000_cousub(api_key: str | None, refresh: bool):
    url = f'{API_BASE}/2000/dec/sf1'
    params = {'get': f'NAME,{POP_VAR_DEC2000}', 'for': 'county subdivision:*', 'in': f'state:{NJ_STATE_FIPS} county:*'}
    return fetch_cached('dec2000_cousub', url, params, api_key, refresh)


@command('fetch')
@option('-k', '--api-key', envvar='CENSUS_API_KEY', help='Census API key (default: $CENSUS_API_KEY)')
@option('-l', '--level', type=str, multiple=True, help='Restrict to level(s): state, county, cousub. Default: all.')
@option('-r', '--refresh', is_flag=True, help='Re-fetch even if cached')
@option('-s', '--sleep', 'sleep_s', type=float, default=0.1, help='Inter-request sleep (seconds)')
@option('-y', '--year', type=int, multiple=True, help=f'ACS 5-yr end year(s). Default: {ACS5_FIRST_YEAR}-{ACS5_LAST_YEAR}.')
def main(api_key, level, refresh, sleep_s, year):
    """Fetch and cache Census population JSON for NJ."""
    if not api_key:
        err('warning: $CENSUS_API_KEY not set; rate-limited to ~500 req/day')
    levels = set(level) if level else {'state', 'county', 'cousub'}
    bad = levels - {'state', 'county', 'cousub'}
    if bad:
        raise SystemExit(f'unknown level(s): {sorted(bad)}')
    years = list(year) if year else list(range(ACS5_FIRST_YEAR, ACS5_LAST_YEAR + 1))
    err(f'levels: {sorted(levels)}; years: {years[0]}-{years[-1]} ({len(years)} vintages)')
    for y in years:
        if 'state' in levels:
            fetch_acs5_state(y, api_key, refresh)
            sleep(sleep_s)
        if 'county' in levels:
            fetch_acs5_county(y, api_key, refresh)
            sleep(sleep_s)
        if 'cousub' in levels:
            fetch_acs5_cousub(y, api_key, refresh)
            sleep(sleep_s)
    if 'cousub' in levels:
        fetch_dec2000_cousub(api_key, refresh)
    err('done')


if __name__ == '__main__':
    main()
