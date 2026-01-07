import re
from os.path import basename

from datetime import datetime

from click import argument
import pandas as pd
import requests
from utz import err, process, s3
from utz.cli import flag

from .base import command
from ..paths import fauqstats_relpath, S3_XML_FETCH_LOG


def parse_rundate(xml_content: bytes) -> str | None:
    """Extract RUNDATE from XML content."""
    match = re.search(rb'<RUNDATE>([^<]+)</RUNDATE>', xml_content)
    return match.group(1).decode('utf-8') if match else None


def update_years(*years, current_year: int = None, log_s3: bool = False):
    """Update FAUQStats XML files for the given years.

    Args:
        years: Years to update
        current_year: If provided, 404 errors for this year are tolerated (file may not exist yet)
        log_s3: If True, append fetch metadata to S3 parquet log
    """
    fetch_records = []
    fetch_time = datetime.now()
    for year in years:
        out_path = fauqstats_relpath(year)
        name = basename(out_path)
        res = requests.get(
            f'https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/{name}',
            allow_redirects=True,
            timeout=10,
            headers={
                'Accept': 'text/xml',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        )
        if res.status_code == 404 and year == current_year:
            # Current year's file may not exist yet (e.g., at the start of a new year)
            err(f"Skipping {name}: 404 Not Found (current year file not yet available)")
            continue
        if res.status_code != 200:
            raise ValueError(f"Failed to download {name}: {res.status_code} {res.reason}")
        if res.headers.get('Content-Type') != 'text/xml':
            raise ValueError(f"Unexpected content type for {name}: {res.headers.get('Content-Type')}")

        content = res.content
        with open(out_path, 'wb') as f:
            f.write(content)

        # Record fetch metadata
        fetch_records.append({
            'fetch_time': fetch_time,
            'year': year,
            'last_modified': res.headers.get('Last-Modified'),
            'rundate': parse_rundate(content),
            'content_length': len(content),
        })

        process.run('git', 'add', out_path)

    # Append to S3 fetch log
    if log_s3 and fetch_records:
        new_df = pd.DataFrame(fetch_records)
        new_df['year'] = new_df['year'].astype(int)
        try:
            existing = pd.read_parquet(S3_XML_FETCH_LOG)
            existing['year'] = existing['year'].astype(int)
            df = pd.concat([existing, new_df], ignore_index=True)
        except FileNotFoundError:
            df = new_df
        with s3.atomic_edit(S3_XML_FETCH_LOG, create_ok=True) as tmp:
            df.to_parquet(tmp, index=False)
        err(f"Appended {len(fetch_records)} records to {S3_XML_FETCH_LOG}")


@command
@flag('--s3', 'log_s3', help='Log fetch metadata to S3')
@argument('years', nargs=-1)
def refresh_data(log_s3, years):
    """Snapshot NJSP fatal crash data for the given years."""
    current_year = datetime.now().year
    if not years:
        years = [ current_year - 2, current_year - 1, current_year ]
    update_years(*years, current_year=current_year, log_s3=log_s3)
    return 'Refresh NJSP data'
