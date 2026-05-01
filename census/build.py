"""Assemble `census/data/population.parquet` from cached Census JSON.

Long-format output: one row per `(year, level, cc, mc)` with columns
`population` and `source`. Levels: state, county, muni. Vintages: ACS 5-yr
end-year 2009-2023 (`source='acs5'`); Decennial 2000 (`source='dec2000'`);
linear interpolation 2001-2008 between the 2000 and 2009 anchors
(`source='interp'`).

State + county pre-2009 anchors are summed up from the cousub-level
Decennial 2000 file (we don't fetch state/county SF1 separately — the sum
matches the published totals to within rounding).

Muni-level reconciliation: Census GEOIDs change with mergers/renames. The
`GEOID_REDIRECTS` map below folds pre-merger / pre-rename rows into the
canonical post-merger GEOID (multiple → one allowed; sums on aggregation).
"""
import json
from os.path import join

import pandas as pd
from utz import err

from census import (
    ACS5_FIRST_YEAR, ACS5_LAST_YEAR, CENSUS_DIR, DATA_DIR, RAW_DIR,
    POP_VAR_ACS, POP_VAR_DEC2000,
)
from census.harmonize import NJ_FIPS_TO_CC

# Canonical bundle location — served directly to the FE (matches the
# `www/public/njdot/cc2mc2mn.json` convention).
WWW_CENSUS = join(CENSUS_DIR, '..', 'www', 'public', 'census')
OUT_PQT = join(WWW_CENSUS, 'population.parquet')
COUSUB_CODES_PQT = join(DATA_DIR, 'nj_cousub_codes.parquet')
DEC2000_YEAR = 2000

# Pre-merger / pre-rename GEOID → canonical post-merger GEOID.
# Multiple rows can redirect to one canonical (Princeton Boro+Twp → Princeton);
# population aggregation handles the sum.
GEOID_REDIRECTS = {
    # 2013 Princeton Boro+Twp merger. Census reused the Borough's GEOID for
    # the merged entity, so only the Twp's GEOID needs redirecting.
    '3402160915': '3402160900',  # Princeton Twp → Princeton
    # 2022 Pine Valley dissolution into Pine Hill.
    '3400758920': '3400758770',
    # Renames between Decennial 2000 and ACS 2009 (canonical = ACS GEOID):
    '3401309220': '3401309250',  # Caldwell Boro (Essex) — GEOID changed
    '3402918130': '3402973125',  # Dover Twp → Toms River Twp (renamed ~2006)
    '3403179820': '3403182423',  # West Paterson Boro → Woodland Park Boro (~2008)
    '3402568670': '3402537560',  # South Belmar Boro → Lake Como Boro (~2009)
    '3402177210': '3402163850',  # Mercer Washington Twp → Robbinsville Twp (~2007)
}


def _read_cache(name: str):
    return json.load(open(join(RAW_DIR, f'{name}.json')))


def _state_rows():
    """State-level rows from each ACS 5-yr vintage's `state.json`."""
    rows = []
    for y in range(ACS5_FIRST_YEAR, ACS5_LAST_YEAR + 1):
        d = _read_cache(f'acs5_{y}_state')
        # Header + one row per state (NJ only).
        _, pop, _state = d[1]
        rows.append({'year': y, 'level': 'state', 'cc': pd.NA, 'mc': pd.NA,
                     'population': int(pop), 'source': 'acs5'})
    return pd.DataFrame(rows)


def _county_rows():
    """County-level rows from each ACS 5-yr vintage's `county.json`."""
    rows = []
    for y in range(ACS5_FIRST_YEAR, ACS5_LAST_YEAR + 1):
        d = _read_cache(f'acs5_{y}_county')
        for _name, pop, _state, fips in d[1:]:
            rows.append({'year': y, 'level': 'county', 'cc': NJ_FIPS_TO_CC[fips], 'mc': pd.NA,
                         'population': int(pop), 'source': 'acs5'})
    return pd.DataFrame(rows)


def _cousub_rows_raw(name: str, var: str):
    """Parse a cousub JSON into raw `(geoid, population)` rows; redirects applied."""
    d = _read_cache(name)
    rows = []
    for r in d[1:]:
        name_full, pop, _state, fips_county, cousub_fips = r
        if 'not defined' in name_full:
            continue
        geoid = f'34{fips_county}{cousub_fips}'
        geoid = GEOID_REDIRECTS.get(geoid, geoid)
        rows.append({'cousub_geoid': geoid, 'population': int(pop)})
    return pd.DataFrame(rows)


def _muni_rows():
    """Muni-level rows: ACS5 2009-2023 + dec2000 anchor (sums after redirect)."""
    codes = pd.read_parquet(COUSUB_CODES_PQT)[['cc', 'mc', 'cousub_geoid']]
    out = []
    for y in range(ACS5_FIRST_YEAR, ACS5_LAST_YEAR + 1):
        raw = _cousub_rows_raw(f'acs5_{y}_cousub', POP_VAR_ACS)
        agg = raw.groupby('cousub_geoid', as_index=False)['population'].sum()
        df = agg.merge(codes, on='cousub_geoid', validate='1:1')
        df['year'] = y
        df['level'] = 'muni'
        df['source'] = 'acs5'
        out.append(df[['year', 'level', 'cc', 'mc', 'population', 'source']])
    # dec2000 cousub anchor.
    raw_dec = _cousub_rows_raw('dec2000_cousub', POP_VAR_DEC2000)
    agg_dec = raw_dec.groupby('cousub_geoid', as_index=False)['population'].sum()
    df_dec = agg_dec.merge(codes, on='cousub_geoid', validate='1:1')
    df_dec['year'] = DEC2000_YEAR
    df_dec['level'] = 'muni'
    df_dec['source'] = 'dec2000'
    out.append(df_dec[['year', 'level', 'cc', 'mc', 'population', 'source']])
    return pd.concat(out, ignore_index=True)


def _state_dec2000(muni_dec):
    """Sum cousub-level dec2000 to get the state total."""
    pop = int(muni_dec['population'].sum())
    return pd.DataFrame([{'year': DEC2000_YEAR, 'level': 'state', 'cc': pd.NA, 'mc': pd.NA,
                          'population': pop, 'source': 'dec2000'}])


def _county_dec2000(muni_dec):
    """Sum cousub-level dec2000 to get county totals."""
    g = muni_dec.groupby('cc', as_index=False)['population'].sum()
    g['year'] = DEC2000_YEAR
    g['level'] = 'county'
    g['mc'] = pd.NA
    g['source'] = 'dec2000'
    g['population'] = g['population'].astype(int)
    return g[['year', 'level', 'cc', 'mc', 'population', 'source']]


def _interpolate(df):
    """Linear-interpolate 2001-2008 from (2000, dec2000) → (2009, acs5)."""
    pivot = df.pivot_table(index=['level', 'cc', 'mc'], columns='year', values='population', dropna=False)
    if DEC2000_YEAR not in pivot.columns or ACS5_FIRST_YEAR not in pivot.columns:
        raise AssertionError(f'missing anchor years; have {pivot.columns.tolist()}')
    p2000 = pivot[DEC2000_YEAR]
    p2009 = pivot[ACS5_FIRST_YEAR]
    interp_rows = []
    for y in range(DEC2000_YEAR + 1, ACS5_FIRST_YEAR):
        # Linear interp at fractional position (y-2000) / 9
        frac = (y - DEC2000_YEAR) / (ACS5_FIRST_YEAR - DEC2000_YEAR)
        pop = (p2000 * (1 - frac) + p2009 * frac).round().astype('Int64')
        interp = pop.reset_index().rename(columns={0: 'population'})
        interp.columns = ['level', 'cc', 'mc', 'population']
        interp = interp[~interp['population'].isna()]
        interp['year'] = y
        interp['source'] = 'interp'
        interp_rows.append(interp[['year', 'level', 'cc', 'mc', 'population', 'source']])
    return pd.concat(interp_rows, ignore_index=True)


def build():
    err('building muni rows (ACS5 + dec2000)...')
    muni = _muni_rows()
    muni_dec = muni[muni['year'] == DEC2000_YEAR]
    err(f'  {len(muni)} muni rows, {len(muni_dec)} from dec2000')

    err('building state + county rows (ACS5 + dec2000)...')
    state = pd.concat([_state_rows(), _state_dec2000(muni_dec)], ignore_index=True)
    county = pd.concat([_county_rows(), _county_dec2000(muni_dec)], ignore_index=True)
    err(f'  state: {len(state)} rows; county: {len(county)} rows')

    combined = pd.concat([state, county, muni], ignore_index=True)

    err('interpolating 2001-2008...')
    interp = _interpolate(combined)
    err(f'  {len(interp)} interpolated rows')

    out = pd.concat([combined, interp], ignore_index=True)
    out = out.astype({
        'year': 'int16',
        'level': pd.CategoricalDtype(['state', 'county', 'muni']),
        'cc': 'Int8',
        'mc': 'Int8',
        'population': 'int32',
        'source': pd.CategoricalDtype(['acs5', 'dec2000', 'interp']),
    })
    out = out.sort_values(['year', 'level', 'cc', 'mc'], na_position='first').reset_index(drop=True)
    return out


def main():
    out = build()
    out.to_parquet(OUT_PQT)
    err(f'wrote {OUT_PQT} ({len(out)} rows)')
    err(f'  by level: {out["level"].value_counts().to_dict()}')
    err(f'  by source: {out["source"].value_counts().to_dict()}')
    err(f'  year range: {out["year"].min()}-{out["year"].max()}')


if __name__ == '__main__':
    main()
