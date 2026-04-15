import hashlib
import re
from os.path import basename
from pathlib import Path

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


def rundate_short(rundate_str: str) -> str:
    """Extract short date (e.g. '4/9') from RUNDATE string like 'Thu Apr 09 10:00:01 EDT 2026'."""
    from email.utils import parsedate
    parts = rundate_str.replace('EDT ', '').replace('EST ', '')
    try:
        dt = datetime.strptime(parts, '%a %b %d %H:%M:%S %Y')
        return f'{dt.month}/{dt.day}'
    except ValueError:
        return rundate_str


def update_xml_dvc(out_path: str, content: bytes, response=None):
    """Update the .dvc provenance file for a fetched XML.

    Writes both `outs[0]` (md5, size) and — when `response` is provided —
    `deps[0]` (checksum from ETag, size, mtime from Last-Modified) plus
    `meta.import.fetched`. Matches the shape that `dvx import-url --git`
    produces, so `dvx update` can use the dvc as-is for ETag-based
    re-fetch checks.
    """
    import yaml
    dvc_path = Path(out_path + '.dvc')
    if not dvc_path.exists():
        return
    md5 = hashlib.md5(content).hexdigest()
    size = len(content)
    with open(dvc_path) as f:
        data = yaml.safe_load(f)
    if data and 'outs' in data:
        data['outs'][0]['md5'] = md5
        data['outs'][0]['size'] = size
    if data and 'deps' in data and response is not None:
        d = data['deps'][0]
        d['size'] = size
        etag = response.headers.get('ETag')
        if etag:
            d['checksum'] = etag
        last_mod = response.headers.get('Last-Modified')
        if last_mod:
            from email.utils import parsedate_to_datetime
            d['mtime'] = parsedate_to_datetime(last_mod).isoformat()
    if data and 'meta' in data:
        data['meta'].setdefault('import', {})
        data['meta']['import']['fetched'] = datetime.now().date().isoformat()
    with open(dvc_path, 'w') as f:
        yaml.dump(data, f, sort_keys=False, default_flow_style=False)
    process.run('git', 'add', str(dvc_path))


def update_years(*years, current_year: int = None, log_s3: bool = False):
    """Update FAUQStats XML files for the given years.

    Args:
        years: Years to update
        current_year: If provided, 404 errors for this year are tolerated (file may not exist yet)
        log_s3: If True, append fetch metadata to S3 parquet log

    Returns:
        Latest RUNDATE string across all fetched XMLs, or None.
    """
    fetch_records = []
    fetch_time = datetime.now()
    latest_rundate = None
    for year in years:
        out_path = fauqstats_relpath(year)
        name = basename(out_path)
        res = requests.get(
            f'https://njsp.njoag.gov/wp/wp-content/plugins/fatal-crash-data/xml/{name}',
            allow_redirects=True,
            timeout=30,
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

        rundate = parse_rundate(content)

        # Record fetch metadata
        fetch_records.append({
            'fetch_time': fetch_time,
            'year': year,
            'last_modified': res.headers.get('Last-Modified'),
            'rundate': rundate,
            'content_length': len(content),
        })

        # Track latest rundate (from current year XML)
        if year == current_year and rundate:
            latest_rundate = rundate

        process.run('git', 'add', out_path)
        update_xml_dvc(out_path, content, response=res)

    # Append to S3 fetch log
    if log_s3 and fetch_records:
        new_df = pd.DataFrame(fetch_records)
        new_df['year'] = new_df['year'].astype(int)
        for rec in fetch_records:
            err(f"  {rec['year']}: mtime={rec['last_modified']}, rundate={rec['rundate']}")
        try:
            existing = pd.read_parquet(S3_XML_FETCH_LOG)
            existing['year'] = existing['year'].astype(int)
            df = pd.concat([existing, new_df], ignore_index=True)
        except FileNotFoundError:
            df = new_df
        with s3.atomic_edit(S3_XML_FETCH_LOG, create_ok=True) as tmp:
            df.to_parquet(tmp, index=False)
        err(f"Appended {len(fetch_records)} records to {S3_XML_FETCH_LOG}")

    return latest_rundate


@command
@flag('--s3', 'log_s3', help='Log fetch metadata to S3')
@argument('years', nargs=-1)
def refresh_data(log_s3, years):
    """Snapshot NJSP fatal crash data for the given years."""
    current_year = datetime.now().year
    if not years:
        years = [current_year - 2, current_year - 1, current_year]
    latest_rundate = update_years(*years, current_year=current_year, log_s3=log_s3)
    date_suffix = f' ({rundate_short(latest_rundate)})' if latest_rundate else ''
    return f'Refresh NJSP data{date_suffix}'
