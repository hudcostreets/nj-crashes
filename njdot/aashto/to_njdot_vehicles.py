"""Convert AASHTO-schema `vehicles.parquet` (per-year, under `njdot/data/
{year}/`) to a denormalized vehicles supplement for 2024+.

Output schema: `(year, cc, mc, case, damage, departure)`, written to
`njdot/data/aashto_supplemented_vehicles.parquet`. Downstream `agg.py`
joins this on `(year, cc, mc, case)` to populate per-vehicle Damage +
Departure facets for AASHTO years.

Mapping decisions:
  - Extent of Damage → damage code 1-4 (legacy NJDOT scale):
      'None'                 → 1
      'Minor'                → 2
      'Moderate/Functional'  → 3
      'Disabling'            → 4
      'Unknown' / 'Not Applicable' / blank → <NA>
  - Removed To → departure code 1-3 (legacy was 1-6; AASHTO collapses
    the towed variants and adds "fled scene". Map to the 3-bucket
    scheme that `agg.py`'s VEP_COLS already uses):
      "Driven*"/"Destination"/"Driver"/"Owner"/"Spouse"… → 1 (Driven)
      "Left*"/"Fled*"/"Abandoned*"                       → 2 (Left)
      anything containing "Tow" / "Impound"             → 3 (Towed)
      "None" / "Unknown" / blank                         → <NA>
    "None" is by far the most common value (~73% of rows) but appears
    to be a missing-data sentinel rather than a meaningful state, so
    those go to Unknown.
"""
import sys
from functools import partial

import click
import pandas as pd

from njdot.aashto.to_njdot_schema import load_cc2mc2mn, lookup_cc_mc
from njdot.paths import AASHTO_SUPPLEMENTED_VEHICLES, aashto_year_path

err = partial(print, file=sys.stderr)

DAMAGE_MAP = {
    'None': 1,
    'Minor': 2,
    'Moderate/Functional': 3,
    'Disabling': 4,
}


def map_departure(s: str | None) -> int | None:
    """AASHTO 'Removed To' free-text → 3-bucket departure code.

    Key insight: the literal string ``"None"`` is the dominant value (~73% of
    rows) and despite the name does *not* mean "missing" — its damage
    profile (8% Disabling vs 81% Disabling for explicit tow-company rows)
    matches Driven vehicles. Treat ``"None"`` as "drove away under own
    power" (vepd / Driven). The remaining free-text values are
    overwhelmingly tow-company names (~77% Disabling), so anything not
    matching one of the obvious keyword buckets gets bucketed to Towed
    (vept). Only ``None``/blank/``"Unknown"`` → vepu.

    With this mapping, coverage jumps from ~18% to ~99%; the alternative
    (treating ``"None"`` as missing) puts 73% of every AASHTO year in the
    Unknown bucket, which doesn't match the legacy 87-95% coverage profile
    and washes out the chart.
    """
    if s is None or s == '' or s == 'Unknown':
        return None
    if s == 'None':
        return 1  # Driven away (sentinel — no removal needed)
    s_low = s.lower()
    # Left / abandoned
    if any(k in s_low for k in ('left', 'fled', 'abandoned')):
        return 2
    # Driven away (under own power, by driver/owner/etc.)
    if any(k in s_low for k in ('driven', 'destination', 'driver', 'owner', 'spouse', 'parent', 'friend', 'home', 'work', 'family')):
        return 1
    # Tow-company name (explicit "tow"/"impound" or anything else free-text)
    return 3


def process_year(year: int, lookup: dict) -> pd.DataFrame | None:
    from os.path import exists
    crashes_path = aashto_year_path(year, 'crashes.parquet')
    vehicles_path = aashto_year_path(year, 'vehicles.parquet')
    if not exists(crashes_path) or not exists(vehicles_path):
        err(f'  skip {year}: missing {crashes_path} or {vehicles_path}')
        return None

    crashes = pd.read_parquet(crashes_path, columns=['crash_id', 'Case Number', 'County', 'Municipality'])
    veh = pd.read_parquet(vehicles_path, columns=['crash_id', 'Extent of Damage', 'Removed To'])
    err(f'  {year}: {len(veh):,} vehicles across {len(crashes):,} crashes')

    cc_mc = crashes.apply(lambda r: lookup_cc_mc(lookup, r['County'], r['Municipality']), axis=1)
    pk = pd.DataFrame({
        'crash_id': crashes['crash_id'],
        'cc': cc_mc.apply(lambda x: x[0]),
        'mc': cc_mc.apply(lambda x: x[1]),
        'case': crashes['Case Number'].astype(str),
    }).set_index('crash_id')

    v = veh.join(pk, on='crash_id', how='left')
    n_unmatched = v['cc'].isna().sum()
    if n_unmatched:
        err(f'        {n_unmatched:,} vehicles in crashes with no (cc, mc) lookup')

    v['year'] = pd.Series(year, index=v.index, dtype='int32')
    v['damage'] = v['Extent of Damage'].map(DAMAGE_MAP).astype('Int8')
    v['departure'] = v['Removed To'].apply(map_departure).astype('Int8')

    out = v[['year', 'cc', 'mc', 'case', 'damage', 'departure']].copy()
    out = out.dropna(subset=['cc'])  # match the persons adapter pattern
    err(f'        damage codes set: {out["damage"].notna().sum():,}/{len(out):,}')
    err(f'        departure codes set: {out["departure"].notna().sum():,}/{len(out):,}')
    return out.reset_index(drop=True)


@click.command('vehicles')
@click.option('-y', '--years', default='2023,2024,2025', help='Comma-separated years to process')
@click.option('-o', '--output', default=AASHTO_SUPPLEMENTED_VEHICLES, help='Output path for vehicles supplement')
def vehicles(years: str, output: str):
    """AASHTO vehicles → DOTr-style vehicles supplement (damage + departure)."""
    from pathlib import Path
    lookup = load_cc2mc2mn()
    err(f'Loaded cc2mc2mn lookup: {len(lookup):,} (cn, mn) pairs')

    year_list = [int(y) for y in years.split(',')]
    parts = []
    for y in year_list:
        df = process_year(y, lookup)
        if df is not None:
            parts.append(df)

    if not parts:
        err('No years to process.')
        return

    combined = pd.concat(parts, ignore_index=True)
    err(f'\nCombined: {len(combined):,} vehicles')

    Path(output).parent.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(output, index=False)
    err(f'Wrote {output}')
