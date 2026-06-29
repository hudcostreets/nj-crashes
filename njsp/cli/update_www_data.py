#!/usr/bin/env python
"""Generate Parquet data files for frontend plots."""
import json
from os.path import join

import click
import pandas as pd
from utz import err

from njsp.cli.base import command
from njsp.paths import CRASHES_PQT, WWW_NJSP

# `projected.csv` stays CSV — it's tiny (~500B), the FE consumes it via the
# CSV register hook, and parquet's header overhead would dwarf the payload.
# Everything else (monthly: 836KB, ytd: 1.1MB, etc.) flips to parquet.

CC2CN = {
    1: 'Atlantic', 2: 'Bergen', 3: 'Burlington', 4: 'Camden', 5: 'Cape May',
    6: 'Cumberland', 7: 'Essex', 8: 'Gloucester', 9: 'Hudson', 10: 'Hunterdon',
    11: 'Mercer', 12: 'Middlesex', 13: 'Monmouth', 14: 'Morris', 15: 'Ocean',
    16: 'Passaic', 17: 'Salem', 18: 'Somerset', 19: 'Sussex', 20: 'Union', 21: 'Warren',
}

CC2MC2MN_PATH = join('www', 'public', 'njdot', 'cc2mc2mn.json')
CN2CC = {v: k for k, v in CC2CN.items()}


def load_cc2mc2mn():
    """Load municipality name mapping: { cc: { mc: muni_name } }."""
    with open(CC2MC2MN_PATH) as f:
        raw = json.load(f)
    # raw structure: { cc_str: { cn: "County Name", mc2mn: { mc_str: "Muni Name" } } }
    result = {}
    for cc_str, info in raw.items():
        mc2mn = info.get('mc2mn', {})
        result[int(cc_str)] = {int(mc): name for mc, name in mc2mn.items()}
    return result


def muni_label(cc, mc, cc2mc2mn):
    """Return 'MuniName (CountyName)' for a given cc/mc pair."""
    cn = CC2CN.get(cc, f'County {cc}')
    mn = cc2mc2mn.get(cc, {}).get(mc, f'Muni {mc}')
    return cn, mn


@command
@click.option('-f', '--force', is_flag=True, help="Force regeneration even if files exist")
def update_www_data(force):
    """Generate Parquet data files for frontend plots."""
    err(f"Loading {CRASHES_PQT}...")
    crashes = pd.read_parquet(CRASHES_PQT)

    # Load municipality names
    cc2mc2mn = load_cc2mc2mn()

    # Add derived columns
    crashes['year'] = crashes['dt'].dt.year
    crashes['month'] = crashes['dt'].dt.month
    crashes['day_of_year'] = crashes['dt'].dt.dayofyear
    crashes['fatalities'] = crashes['tk'].fillna(0).astype(int)
    crashes['driver'] = crashes['dk'].fillna(0).astype(int)
    crashes['passenger'] = crashes['ok'].fillna(0).astype(int)
    crashes['pedestrian'] = crashes['pk'].fillna(0).astype(int)
    crashes['cyclist'] = crashes['bk'].fillna(0).astype(int)
    crashes['county'] = crashes['cc'].map(CC2CN).fillna('')

    # Build list of (cc, mc) pairs present in data
    muni_pairs = (
        crashes[['cc', 'mc']].drop_duplicates()
        .sort_values(['cc', 'mc'])
        .values.tolist()
    )

    # 1. YTD data: cumulative deaths by day of year for each year
    ytd_path = join(WWW_NJSP, 'ytd.parquet')
    err(f"Generating {ytd_path}...")

    type_cols = ['driver', 'passenger', 'pedestrian', 'cyclist']
    ytd_cum_cols = [f'{c}_cumulative' for c in type_cols] + ['cumulative']
    ytd_out_cols = [
        'county', 'cc', 'mc', 'year', 'day_of_year', 'date_label',
        'fatalities', *type_cols, 'cumulative', *(f'{c}_cumulative' for c in type_cols),
    ]

    def compute_ytd(df, county=None, cc=None, mc=None):
        agg_cols = {'fatalities': 'sum', **{c: 'sum' for c in type_cols}}
        ytd = (
            df
            .groupby(['year', 'day_of_year'])
            .agg(agg_cols)
            .reset_index()
        )
        ytd['cumulative'] = ytd.groupby('year')['fatalities'].cumsum()
        for c in type_cols:
            ytd[f'{c}_cumulative'] = ytd.groupby('year')[c].cumsum()
        ytd['date_label'] = pd.to_datetime(ytd['day_of_year'], format='%j').dt.strftime('%b %d')
        ytd['county'] = county
        ytd['cc'] = cc
        ytd['mc'] = mc
        return ytd[ytd_out_cols]

    ytd_parts = [compute_ytd(crashes)]
    for cn in sorted(CC2CN.values()):
        ytd_parts.append(compute_ytd(crashes[crashes['county'] == cn], cn, cc=CN2CC[cn]))
    for cc_val, mc_val in muni_pairs:
        cn = CC2CN.get(cc_val, None)
        mn = cc2mc2mn.get(cc_val, {}).get(mc_val, f'Muni {mc_val}')
        muni_data = crashes[(crashes['cc'] == cc_val) & (crashes['mc'] == mc_val)]
        if muni_data['fatalities'].sum() > 0:
            ytd_parts.append(compute_ytd(muni_data, cn, cc_val, mc_val))
    ytd = pd.concat(ytd_parts, ignore_index=True)
    ytd['cc'] = ytd['cc'].astype('Int64')
    ytd['mc'] = ytd['mc'].astype('Int64')
    ytd.to_parquet(ytd_path, compression='snappy', index=False)
    err(f"  Wrote {len(ytd)} rows")

    # 2. Monthly timeseries: deaths per month with 12-mo rolling average
    monthly_path = join(WWW_NJSP, 'monthly.parquet')
    err(f"Generating {monthly_path}...")

    def compute_monthly(df, county=None, cc=None, mc=None):
        agg_cols = {'fatalities': 'sum', 'driver': 'sum', 'passenger': 'sum', 'pedestrian': 'sum', 'cyclist': 'sum'}
        monthly = (
            df
            .groupby(['year', 'month'])
            .agg(agg_cols)
            .reset_index()
        )
        monthly['date'] = pd.to_datetime(monthly['year'].astype(str) + '-' + monthly['month'].astype(str).str.zfill(2) + '-01')
        monthly = monthly.sort_values('date')
        monthly['avg_12mo'] = monthly['fatalities'].rolling(window=12, min_periods=1).mean().round(1)
        monthly['county'] = county
        monthly['cc'] = cc
        monthly['mc'] = mc
        return monthly[['county', 'cc', 'mc', 'date', 'year', 'month', 'fatalities', 'driver', 'passenger', 'pedestrian', 'cyclist', 'avg_12mo']]

    monthly_parts = [compute_monthly(crashes)]
    for cn in sorted(CC2CN.values()):
        monthly_parts.append(compute_monthly(crashes[crashes['county'] == cn], cn, cc=CN2CC[cn]))
    for cc_val, mc_val in muni_pairs:
        cn = CC2CN.get(cc_val, None)
        muni_data = crashes[(crashes['cc'] == cc_val) & (crashes['mc'] == mc_val)]
        if muni_data['fatalities'].sum() > 0:
            monthly_parts.append(compute_monthly(muni_data, cn, cc_val, mc_val))
    monthly = pd.concat(monthly_parts, ignore_index=True)
    monthly['cc'] = monthly['cc'].astype('Int64')
    monthly['mc'] = monthly['mc'].astype('Int64')

    monthly.to_parquet(monthly_path, compression='snappy', index=False)
    err(f"  Wrote {len(monthly)} rows")

    # 3. Month-year data: deaths by year and month
    month_year_path = join(WWW_NJSP, 'month-year.parquet')
    err(f"Generating {month_year_path}...")

    def compute_month_year(df, county=None, cc=None, mc=None):
        my = (
            df
            .groupby(['year', 'month'])['fatalities']
            .sum()
            .reset_index()
        )
        my['county'] = county
        my['cc'] = cc
        my['mc'] = mc
        return my[['county', 'cc', 'mc', 'year', 'month', 'fatalities']]

    my_parts = [compute_month_year(crashes)]
    for cn in sorted(CC2CN.values()):
        my_parts.append(compute_month_year(crashes[crashes['county'] == cn], cn, cc=CN2CC[cn]))
    for cc_val, mc_val in muni_pairs:
        cn = CC2CN.get(cc_val, None)
        muni_data = crashes[(crashes['cc'] == cc_val) & (crashes['mc'] == mc_val)]
        if muni_data['fatalities'].sum() > 0:
            my_parts.append(compute_month_year(muni_data, cn, cc_val, mc_val))
    month_year = pd.concat(my_parts, ignore_index=True)
    month_year['cc'] = month_year['cc'].astype('Int64')
    month_year['mc'] = month_year['mc'].astype('Int64')
    month_year.to_parquet(month_year_path, compression='snappy', index=False)
    err(f"  Wrote {len(month_year)} rows")

    # 4. year-type-county: per-year, per-county fatality breakdown by victim type
    ytc_path = join(WWW_NJSP, 'year-type-county.parquet')
    err(f"Generating {ytc_path}...")
    ytc = (
        crashes[crashes['county'] != '']
        .groupby(['year', 'county'])
        .agg(driver=('driver', 'sum'),
             passenger=('passenger', 'sum'),
             cyclist=('cyclist', 'sum'),
             pedestrian=('pedestrian', 'sum'),
             crashes=('year', 'size'))
        .reset_index()
    )
    ytc.to_parquet(ytc_path, compression='snappy', index=False)
    err(f"  Wrote {len(ytc)} rows")

    # 5. Crash-homicide comparison (NJSP + NJDOT traffic deaths vs UCR homicides)
    crash_homicide_path = join(WWW_NJSP, 'crash-homicide.parquet')
    err(f"Generating {crash_homicide_path}...")
    try:
        from nj_crashes.paths import COUNTY_HOMICIDES_PQT, HOMICIDES_PQT

        homicides = pd.read_parquet(HOMICIDES_PQT)['homicides']
        parts = []

        def make_cmp(td, hom, county='', source='njsp'):
            cmp = pd.DataFrame({
                'traffic_deaths': td,
                'homicides': hom,
            }).dropna().astype(int)
            if cmp.empty:
                return None
            cmp['ratio'] = cmp.apply(
                lambda r: round(r['traffic_deaths'] / r['homicides'], 2) if r['homicides'] > 0 else None,
                axis=1,
            )
            cmp['county'] = county
            cmp['source'] = source
            return cmp.reset_index()

        # --- Statewide NJSP ---
        sp_td = crashes.groupby('year')['fatalities'].sum()
        sp_td.index.name = 'year'
        sp_cmp = make_cmp(sp_td, homicides, source='njsp')
        if sp_cmp is not None:
            parts.append(sp_cmp)

        # --- Statewide NJDOT ---
        try:
            cm = pd.read_parquet(join('njdot', 'data', 'cm.pqt'))
            dot_td = cm.groupby(cm['Date'].dt.year)['Total Killed'].sum()
            dot_td.index.name = 'year'
            dot_cmp = make_cmp(dot_td, homicides, source='njdot')
            if dot_cmp is not None:
                parts.append(dot_cmp)
        except Exception as e:
            err(f"  Warning: Could not load NJDOT cm.pqt for statewide: {e}")

        # --- Per-county (NJSP + UCR homicides) ---
        try:
            county_hom = pd.read_parquet(COUNTY_HOMICIDES_PQT)
            county_td = crashes.groupby(['year', 'county'])['fatalities'].sum().reset_index()
            county_td = county_td.rename(columns={'fatalities': 'traffic_deaths'})

            for cn in sorted(CC2CN.values()):
                td = county_td[county_td['county'] == cn].set_index('year')['traffic_deaths']
                hom = county_hom[county_hom['county'] == cn].set_index('year')['murders']
                cmp = make_cmp(td, hom, county=cn, source='njsp')
                if cmp is not None:
                    parts.append(cmp)
        except Exception as e:
            err(f"  Warning: Could not generate county-level crash-homicide data: {e}")

        result = pd.concat(parts, ignore_index=True)
        result = result[['source', 'county', 'year', 'traffic_deaths', 'homicides', 'ratio']]
        result.to_parquet(crash_homicide_path, compression='snappy', index=False)
        err(f"  Wrote {len(result)} rows")
    except Exception as e:
        err(f"  Warning: Could not generate crash-homicide data: {e}")

    return "Update www data Parquets"
