#!/usr/bin/env python
"""Project rest-of-year NJSP fatalities and write `projected.csv`.

For each (geo, victim-type), scale last year's rest-of-year deaths by how
the current year's YTD count compares to last year's YTD (see
`projected_roy_deaths`). Runs at county and municipality granularity;
county rows are keyed by `county` name (blank cc/mc/municipality), muni
rows by canonical NJGIN `(cc, mc)`. The frontend sums `mc IS NULL` rows
(the county rows) for the statewide projection.

Was `njsp/update-projections.ipynb` — converted to a plain module so the
daily `projections.dvc` re-run stops churning notebook output cells (the
same reason `harmonize-muni-codes.ipynb` became `harmonize_muni_codes.py`).
"""
from datetime import datetime
from os import chdir
from os.path import exists

import pandas as pd
from utz import err, sxs

from nj_crashes.paths import ROOT_DIR
from njsp import Ytd
from njsp.cli.base import command
from njsp.paths import PROJECTED_CSV, fauqstats_relpath
from njsp.ytc import to_ytc, to_ytmc
from njsp.ytd import projected_roy_deaths

PROJECTED_COLS = ['cc', 'mc', 'county', 'municipality', 'crashes', 'cyclist', 'driver', 'passenger', 'pedestrian']


def melt(df, name):
    """Melt a geo×type count frame to a `(…, type)`-indexed Series named `name`."""
    return (
        df
        .melt(ignore_index=False, var_name='type')
        .set_index('type', append=True)
        .value
        .rename(name)
    )


def project_roy(r, cur_ytd_frac):
    return int(round(projected_roy_deaths(r.prv_ytd, r.prv_end, r.cur_ytd, cur_ytd_frac)))


def project(prv_ytd, prv_end, cur_ytd, cur_ytd_frac):
    """Project current-year totals (per geo × type) from previous-year
    YTD/end and current-year YTD counts. Granularity (county, or
    county+municipality) follows the index of the inputs."""
    z = sxs(
        melt(prv_ytd, 'prv_ytd'),
        melt(prv_end, 'prv_end'),
        melt(cur_ytd, 'cur_ytd'),
    ).fillna(0).astype(int)
    roy = z.apply(lambda r: project_roy(r, cur_ytd_frac), axis=1).rename('roy')
    return (
        (z.cur_ytd + roy)
        .rename('projected')
        .reset_index(level='type')
        .pivot(columns='type', values='projected')
    )


@command
def update_projections():
    """Update projected rest-of-year fatalities based on latest NJSP data."""
    current_year = datetime.now().year
    fauqstats_path = fauqstats_relpath(current_year)
    if not exists(fauqstats_path):
        err(f"Skipping projections: {fauqstats_path} not found (current year data not yet available)")
        return f"Skip NJSP projections ({current_year} data not yet available)"

    chdir(ROOT_DIR)  # `Ytd` walks git history; run from the repo root
    ytd = Ytd()
    prv_year = ytd.prv_year
    cur_year = ytd.cur_year
    cur_ytd_frac = ytd.cur_year_frac

    pct_change = (ytd.cur_ytd_deaths / ytd.prv_ytd_deaths - 1) * 100
    err(f"As of {ytd.prv_rundate}, NJSP reported {ytd.prv_ytd_total} YTD deaths")
    err(f"Current YTD deaths ({ytd.rundate}): {ytd.cur_ytd_deaths}")
    err(f"Projected {cur_year} total: {ytd.projected_year_total:.0f} ({pct_change:+.1f}% vs prior YTD)")
    err(f"{cur_ytd_frac * 100:.1f}% of the year elapsed")

    prv_crashes = ytd.prv_ytd_crashes
    prv_end_crashes = ytd.prv_end_crashes
    cur_crashes = ytd.cur_ytd_crashes

    projected_county = project(
        to_ytc(prv_crashes).loc[prv_year],
        to_ytc(prv_end_crashes).loc[prv_year],
        to_ytc(cur_crashes).loc[cur_year],
        cur_ytd_frac,
    )
    projected_muni = project(
        to_ytmc(prv_crashes).loc[prv_year],
        to_ytmc(prv_end_crashes).loc[prv_year],
        to_ytmc(cur_crashes).loc[cur_year],
        cur_ytd_frac,
    )

    county_rows = projected_county.reset_index()
    county_rows['cc'] = county_rows['mc'] = county_rows['municipality'] = ''
    projected = pd.concat(
        [county_rows[PROJECTED_COLS], projected_muni.reset_index()[PROJECTED_COLS]],
        ignore_index=True,
    )
    projected.to_csv(PROJECTED_CSV, index=False)
    err(f"Wrote {PROJECTED_CSV}: {len(county_rows)} county + {len(projected_muni)} muni rows")
    return "Update NJSP projections"
