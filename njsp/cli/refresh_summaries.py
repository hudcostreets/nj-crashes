import click
from datetime import datetime
from juq.cli import write_nb
from juq.papermill.run import papermill_run
from requests.exceptions import HTTPError
from utz import cd, err, process

from njsp.cli.base import command
from njsp.paths import ANNUAL_SUMMARIES, annual_ytc_relpath


def run_nb(nb_path, **parameters):
    """Run a notebook with parameters and write it back."""
    parameter_strs = tuple(f'{k}={v}' for k, v in parameters.items())
    nb, exc = papermill_run(nb_path, parameter_strs=parameter_strs)
    write_nb(nb, nb_path)
    if exc:
        raise exc


def refresh_annual_summaries(year):
    with cd(ANNUAL_SUMMARIES):
        nb_path = 'fetch-summaries.ipynb'
        run_nb(nb_path, force=True, years=f'{year}')
        pdf_path = annual_ytc_relpath(year)
        if process.check('git', 'diff', '--exit-code', '--', pdf_path):
            err(f"{pdf_path} unchanged, reverting {nb_path}")
            process.run('git', 'checkout', '--', nb_path,)
            return False
        run_nb('NJSP summary PDFs.ipynb', years=f'{year}')
    return True


@command
@click.argument('years', nargs=-1)
def refresh_summaries(years):
    """Update NJSP annual summary PDFs (fetch-summaries.ipynb)."""
    if not years:
        year = datetime.now().year
        years = [ year - 1 ]

    refreshed_years = []
    for year in years:
        try:
            if refresh_annual_summaries(year):
                refreshed_years.append(year)
        except (HTTPError, FileNotFoundError) as e:
            # Expected failures: PDF not yet published (404) or file not found
            err(f"Failed to refresh summaries for {year}: {e}")
            err("Continuing (PDF summaries are optional for years 2020+)")

    if refreshed_years:
        return f'Refresh NJSP annual summaries: {",".join(map(str, refreshed_years))}'
    return None
