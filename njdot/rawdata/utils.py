from functools import partial
from os.path import exists
import utz
from click import option
from utz import err

from njdot.data import REGIONS, YEARS, END_YEAR, START_YEAR
from njdot.opts import parse_opt
from njdot.tbls import types_opt
from njdot.paths import DOT_DATA

# Common options
overwrite_opt = option('-f', '--overwrite', is_flag=True, help="Overwrite the output file, if it exists (default: no-op/skip)")
dry_run_opt = option('-n', '--dry-run', is_flag=True, help="Print conversions that would be performed, don't perform them")

DEFAULT_CACHE_PATH = f'{DOT_DATA}/.cache.pqt'
CACHE_HEADERS = [ 'Date', 'Content-Length', 'Content-type', 'Last-modified', 'Etag', ]


def maybe_capemay_space(county, year):
    if county == 'CapeMay' and year in { '2001', '2002', '2003', '2020', }:
        return 'Cape May'
    else:
        return county


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

    def normalize_year(y):
        """Convert 2-digit year to 4-digit (assume 2000s)"""
        if not y:
            return None
        y_int = int(y)
        if y_int < 100:
            return 2000 + y_int
        return y_int

    all_years = []
    for years in years_str.split(','):
        pcs = years.split('-')
        if len(pcs) == 1:
            normalized = normalize_year(pcs[0])
            if normalized:
                all_years.append(normalized)
        elif len(pcs) == 2:
            start, end = pcs
            start = normalize_year(start) if start else START_YEAR
            end = normalize_year(end) if end else END_YEAR
            all_years += list(range(start, end))
        else:
            raise ValueError(f"Unrecognized year piece {years} in {years_str}")
    return list(sorted(list(set(all_years))))


years_opt = parse_opt(
    '-y', '--years',
    parse=parse_years,
    kw='years',
    help=f"Comma-separated list of years (supported range: [{START_YEAR}, {END_YEAR})); ranges also supported, e.g. \"2002-2010\", \"-2010\", \"2017-\"",
)


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
