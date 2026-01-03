from os.path import basename

from datetime import datetime

from click import argument
import requests
from utz import err, process

from .base import command
from ..paths import fauqstats_relpath


def update_years(*years, current_year: int = None):
    """Update FAUQStats XML files for the given years.

    Args:
        years: Years to update
        current_year: If provided, 404 errors for this year are tolerated (file may not exist yet)
    """
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
        with open(out_path, 'wb') as f:
            f.write(res.content)

        process.run('git', 'add', out_path)


@command
@argument('years', nargs=-1)
def refresh_data(years):
    """Snapshot NJSP fatal crash data for the given years."""
    current_year = datetime.now().year
    if not years:
        years = [ current_year - 2, current_year - 1, current_year ]
    update_years(*years, current_year=current_year)
    return 'Refresh NJSP data'
