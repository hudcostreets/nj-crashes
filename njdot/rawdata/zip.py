from os import makedirs
from os.path import exists, dirname
import pandas as pd
import requests
import time
from click import option

from njdot.paths import DOT_DATA
from njdot.tbls import types_opt
from .base import rawdata
from .utils import maybe_capemay_space, regions_opt, years_opt, DEFAULT_CACHE_PATH, CACHE_HEADERS


def cmd(*opts, help=None):
    """Decorator to create commands with common options (regions, types, years)."""
    def wrapper(fn):
        decos = (
            rawdata.command(fn.__name__, short_help=help),
            regions_opt,
            types_opt,
            years_opt,
        ) + opts
        for deco in reversed(decos):
            fn = deco(fn)
        return fn
    return wrapper


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
                    url = f'https://dot.nj.gov/transportation/refdata/accident/{url_name}'
                    out_path = f'{DOT_DATA}/{name}'
                    if exists(out_path):
                        if force:
                            print(f'{url}: force-checking HEAD for extant zip {name}')
                        else:
                            print(f'{url}: skipping, {name} exists')
                            continue
                    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
                    head = requests.head(url, allow_redirects=True, headers=headers)
                    try:
                        head.raise_for_status()
                    except Exception:
                        raise RuntimeError(f"Failed HEAD for {url}")
                    cache_headers = { k: head.headers[k] for k in CACHE_HEADERS }
                    new_row = { 'url': url, **cache_headers }
                    new_row_df = pd.DataFrame([ new_row ]).set_index('url')

                    def download():
                        r = requests.get(url, headers=headers)
                        r.raise_for_status()
                        makedirs(dirname(out_path), exist_ok=True)
                        with open(out_path, 'wb') as f:
                            f.write(r.content)

                    needs_download = True
                    downloaded = False
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
                                downloaded = True
                                needs_download = False
                            elif force == 2:
                                print(f'{url} forced re-download')
                                # Let the needs_download block below handle it
                            else:
                                needs_download = False
                        else:
                            print(f'{url} cache hit')
                            needs_download = False

                    if needs_download:
                        if force == 2:
                            print(f'{url} downloading (forced)')
                        else:
                            print(f'{url} downloading (cache miss)')
                        download()
                        downloaded = True

                    if downloaded:
                        if cache is not None and url in cache.index:
                            cache = pd.concat([ cache.drop(url), new_row_df])
                        else:
                            cache = pd.concat([ cache, new_row_df])
                        updated_paths.append(out_path)

                if sleep:
                    time.sleep(sleep)
    finally:
        if updated_paths:
            print(f'Writing cache ({len(cache)} rows)')
            cache.to_parquet(cache_path)
