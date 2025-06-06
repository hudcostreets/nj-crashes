from os.path import basename

from datetime import datetime

from click import argument
import requests
from utz import process

from .base import command
from ..paths import fauqstats_relpath


def update_years(*years):
    for year in years:
        out_path = fauqstats_relpath(year)
        name = basename(out_path)
        res = requests.get(
            f'https://nj.gov/njsp/info/fatalacc/{name}',
            allow_redirects=True,
            timeout=10,
            headers={
                'Accept': 'text/xml',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/',
            },
        )
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
    if not years:
        year = datetime.now().year
        years = [ year - 2, year - 1, year ]
    update_years(*years)
    return 'Refresh NJSP data'
