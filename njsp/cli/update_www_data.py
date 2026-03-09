#!/usr/bin/env python
"""Generate CSV data files for frontend plots."""
from os.path import join

import click
import pandas as pd
from utz import err

from njsp.cli.base import command
from njsp.paths import CRASHES_PQT, WWW_NJSP

CC2CN = {
    1: 'Atlantic', 2: 'Bergen', 3: 'Burlington', 4: 'Camden', 5: 'Cape May',
    6: 'Cumberland', 7: 'Essex', 8: 'Gloucester', 9: 'Hudson', 10: 'Hunterdon',
    11: 'Mercer', 12: 'Middlesex', 13: 'Monmouth', 14: 'Morris', 15: 'Ocean',
    16: 'Passaic', 17: 'Salem', 18: 'Somerset', 19: 'Sussex', 20: 'Union', 21: 'Warren',
}


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
    crashes['county'] = crashes['cc'].map(CC2CN).fillna('')

    # 1. YTD data: cumulative deaths by day of year for each year (+ county)
    ytd_path = join(WWW_NJSP, 'ytd.csv')
    err(f"Generating {ytd_path}...")

    def compute_ytd(df, county=''):
        ytd = (
            df
            .groupby(['year', 'day_of_year'])['fatalities']
            .sum()
            .reset_index()
        )
        ytd['cumulative'] = ytd.groupby('year')['fatalities'].cumsum()
        ytd['date_label'] = pd.to_datetime(ytd['day_of_year'], format='%j').dt.strftime('%b %d')
        ytd['county'] = county
        return ytd[['county', 'year', 'day_of_year', 'date_label', 'fatalities', 'cumulative']]

    ytd_parts = [compute_ytd(crashes)]
    for cn in sorted(CC2CN.values()):
        ytd_parts.append(compute_ytd(crashes[crashes['county'] == cn], cn))
    ytd = pd.concat(ytd_parts, ignore_index=True)
    ytd.to_csv(ytd_path, index=False)
    err(f"  Wrote {len(ytd)} rows")

    # 2. Monthly timeseries: deaths per month with 12-mo rolling average (+ county)
    monthly_path = join(WWW_NJSP, 'monthly.csv')
    err(f"Generating {monthly_path}...")

    def compute_monthly(df, county=''):
        monthly = (
            df
            .groupby(['year', 'month'])['fatalities']
            .sum()
            .reset_index()
        )
        monthly['date'] = pd.to_datetime(monthly['year'].astype(str) + '-' + monthly['month'].astype(str).str.zfill(2) + '-01')
        monthly = monthly.sort_values('date')
        monthly['avg_12mo'] = monthly['fatalities'].rolling(window=12, min_periods=1).mean().round(1)
        monthly['county'] = county
        return monthly[['county', 'date', 'year', 'month', 'fatalities', 'avg_12mo']]

    monthly_parts = [compute_monthly(crashes)]
    for cn in sorted(CC2CN.values()):
        monthly_parts.append(compute_monthly(crashes[crashes['county'] == cn], cn))
    monthly = pd.concat(monthly_parts, ignore_index=True)
    monthly.to_csv(monthly_path, index=False)
    err(f"  Wrote {len(monthly)} rows")

    # 3. Month-year data: deaths by year and month (+ county)
    month_year_path = join(WWW_NJSP, 'month-year.csv')
    err(f"Generating {month_year_path}...")

    def compute_month_year(df, county=''):
        my = (
            df
            .groupby(['year', 'month'])['fatalities']
            .sum()
            .reset_index()
        )
        my['county'] = county
        return my[['county', 'year', 'month', 'fatalities']]

    my_parts = [compute_month_year(crashes)]
    for cn in sorted(CC2CN.values()):
        my_parts.append(compute_month_year(crashes[crashes['county'] == cn], cn))
    month_year = pd.concat(my_parts, ignore_index=True)
    month_year.to_csv(month_year_path, index=False)
    err(f"  Wrote {len(month_year)} rows")

    # 4. Crash-homicide comparison (requires NJDOT data + homicides)
    crash_homicide_path = join(WWW_NJSP, 'crash-homicide.csv')
    err(f"Generating {crash_homicide_path}...")
    try:
        from njdot.paths import CM_PQT
        from nj_crashes.paths import COUNTY_HOMICIDES_PQT, HOMICIDES_PQT

        # Load NJDOT county-month data for traffic deaths
        cm = pd.read_parquet(CM_PQT)

        # --- Statewide ---
        traffic_deaths = cm.groupby(cm['Date'].dt.year)['Total Killed'].sum()
        traffic_deaths.index.name = 'year'
        homicides = pd.read_parquet(HOMICIDES_PQT)['homicides']
        cmp = pd.DataFrame({
            'traffic_deaths': traffic_deaths,
            'homicides': homicides,
        }).dropna(subset=['traffic_deaths']).astype(int)
        cmp['ratio'] = (cmp['traffic_deaths'] / cmp['homicides']).round(2)
        cmp['county'] = ''
        parts = [cmp.reset_index()]

        # --- Per-county (NJSP crashes + UCR homicides: 2018+) ---
        try:
            county_hom = pd.read_parquet(COUNTY_HOMICIDES_PQT)
            # Traffic deaths per county per year from NJSP crashes (already loaded)
            county_td = crashes.groupby(['year', 'county'])['fatalities'].sum().reset_index()
            county_td = county_td.rename(columns={'fatalities': 'traffic_deaths'})

            for cn in sorted(CC2CN.values()):
                td = county_td[county_td['county'] == cn].set_index('year')['traffic_deaths']
                hom = county_hom[county_hom['county'] == cn].set_index('year')['murders']
                county_cmp = pd.DataFrame({
                    'traffic_deaths': td,
                    'homicides': hom,
                }).dropna().astype(int)
                if county_cmp.empty:
                    continue
                # Avoid division by zero
                county_cmp['ratio'] = county_cmp.apply(
                    lambda r: round(r['traffic_deaths'] / r['homicides'], 2) if r['homicides'] > 0 else None,
                    axis=1,
                )
                county_cmp['county'] = cn
                parts.append(county_cmp.reset_index())
        except Exception as e:
            err(f"  Warning: Could not generate county-level crash-homicide data: {e}")

        result = pd.concat(parts, ignore_index=True)
        result = result[['county', 'year', 'traffic_deaths', 'homicides', 'ratio']]
        result.to_csv(crash_homicide_path, index=False)
        err(f"  Wrote {len(result)} rows")
    except Exception as e:
        err(f"  Warning: Could not generate crash-homicide data: {e}")

    return "Update www data CSVs"
