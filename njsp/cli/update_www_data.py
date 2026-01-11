#!/usr/bin/env python
"""Generate CSV data files for frontend plots."""
from os.path import join

import click
import pandas as pd
from utz import err

from njsp.cli.base import command
from njsp.paths import CRASHES_PQT, WWW_NJSP


@command
@click.option('-f', '--force', is_flag=True, help="Force regeneration even if files exist")
def update_www_data(force):
    """Generate CSV data files for frontend plots."""
    err(f"Loading {CRASHES_PQT}...")
    crashes = pd.read_parquet(CRASHES_PQT)

    # Add derived columns
    crashes['year'] = crashes['dt'].dt.year
    crashes['month'] = crashes['dt'].dt.month
    crashes['day_of_year'] = crashes['dt'].dt.dayofyear
    crashes['fatalities'] = crashes['tk'].fillna(0).astype(int)

    # 1. YTD data: cumulative deaths by day of year for each year
    ytd_path = join(WWW_NJSP, 'ytd.csv')
    err(f"Generating {ytd_path}...")
    ytd = (
        crashes
        .groupby(['year', 'day_of_year'])['fatalities']
        .sum()
        .reset_index()
    )
    # Calculate cumulative sum within each year
    ytd['cumulative'] = ytd.groupby('year')['fatalities'].cumsum()
    # Add date label (for display)
    ytd['date_label'] = pd.to_datetime(ytd['day_of_year'], format='%j').dt.strftime('%b %d')
    ytd = ytd[['year', 'day_of_year', 'date_label', 'fatalities', 'cumulative']]
    ytd.to_csv(ytd_path, index=False)
    err(f"  Wrote {len(ytd)} rows")

    # 2. Monthly timeseries: deaths per month with 12-mo rolling average
    monthly_path = join(WWW_NJSP, 'monthly.csv')
    err(f"Generating {monthly_path}...")
    monthly = (
        crashes
        .groupby(['year', 'month'])['fatalities']
        .sum()
        .reset_index()
    )
    monthly['date'] = pd.to_datetime(monthly['year'].astype(str) + '-' + monthly['month'].astype(str).str.zfill(2) + '-01')
    monthly = monthly.sort_values('date')
    monthly['avg_12mo'] = monthly['fatalities'].rolling(window=12, min_periods=1).mean().round(1)
    monthly = monthly[['date', 'year', 'month', 'fatalities', 'avg_12mo']]
    monthly.to_csv(monthly_path, index=False)
    err(f"  Wrote {len(monthly)} rows")

    # 3. Month-year data: deaths by year and month (for grouped bar chart)
    month_year_path = join(WWW_NJSP, 'month-year.csv')
    err(f"Generating {month_year_path}...")
    month_year = (
        crashes
        .groupby(['year', 'month'])['fatalities']
        .sum()
        .reset_index()
    )
    month_year.to_csv(month_year_path, index=False)
    err(f"  Wrote {len(month_year)} rows")

    # 4. Crash-homicide comparison (requires NJDOT data + homicides)
    crash_homicide_path = join(WWW_NJSP, 'crash-homicide.csv')
    err(f"Generating {crash_homicide_path}...")
    try:
        from njdot.paths import CM_PQT
        from nj_crashes.paths import HOMICIDES_PQT

        # Load NJDOT county-month data for traffic deaths
        cm = pd.read_parquet(CM_PQT)
        traffic_deaths = cm.groupby(cm['Date'].dt.year)['Total Killed'].sum()
        traffic_deaths.index.name = 'year'

        # Load homicides
        homicides = pd.read_parquet(HOMICIDES_PQT)['homicides']

        # Combine
        cmp = pd.DataFrame({
            'traffic_deaths': traffic_deaths,
            'homicides': homicides,
        }).dropna(subset=['traffic_deaths']).astype(int)
        cmp['ratio'] = (cmp['traffic_deaths'] / cmp['homicides']).round(2)
        cmp.to_csv(crash_homicide_path)
        err(f"  Wrote {len(cmp)} rows")
    except Exception as e:
        err(f"  Warning: Could not generate crash-homicide data: {e}")

    return "Update www data CSVs"
