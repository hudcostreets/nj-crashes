#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "pandas", "pyarrow", "tqdm"]
# ///
"""Convert AASHTO-schema `persons.parquet` (output of `normalize.py`) to
final NJDOT-shape `occupants` + `pedestrians` frames for 2024+.

Output schema matches `njdot/data/{occupants,pedestrians}.parquet`
post-pipeline columns (typed Int8 codes, normalized sex/age), with
`(year, cc, mc, case)` denormalized in place of the legacy
`crash_id` row-index pointer. Downstream consumers (`cmymc.py`, `agg.py`)
merge supplements + legacy masters on the PK tuple.

Mapping decisions:
  - cc/mc derived from County + Municipality via `cc2mc2mn.json`,
    reusing `to_njdot_schema.lookup_cc_mc` (handles known AASHTO
    typos + cross-county misclassifications).
  - vehicle_index + 1 → `vn`; per-vehicle row order → `on`.
  - per-crash pedestrian row order → `pn`.
  - Severity Rating (Person) → condition 1-5 (DOTr Physical Condition
    code; 1=Fatal, 5=No Apparent Injury). Pre-existing NJDOT cmymc
    filters `1 <= condition <= 5`, so we leave Unknown rows nullable.
  - Position in Vehicle → pos 1-12 (DOTr Position In/On Vehicle).
  - Person Type 'Pedalcyclist' → cyclist=True.
  - Age: '0' / None → <NA> (AASHTO uses 0 for unknown; DOTr uses
    blank). Other invalid ages (e.g. >110) also → <NA>.

Known AASHTO data-quality issue (2024+):
  - "Ghost-Driver" rows: `Person Type='Driver'` + `Position in
    Vehicle` blank. ~45K/yr; ~240/yr carry `Fatal Injury (K)`. These
    are placeholder rows — for fatal-ped crashes the actual victim is
    on a separate row with `Person Type='Pedestrian'` and
    `Severity Rating='No Apparent Injury (O)'`. We drop ghost-Drivers
    from the occupants supplement entirely. Net effect: 2024+ ped/
    cyclist fatal counts are *under*-reported in the person-level
    breakdown (~19/yr instead of ~228/yr). Crash-level `pk` in
    `aashto_supplemented_crashes.parquet` remains authoritative.
"""
import sys
from functools import partial
from pathlib import Path

import click
import pandas as pd

from njdot.aashto.to_njdot_schema import load_cc2mc2mn, lookup_cc_mc

err = partial(print, file=sys.stderr)

# AASHTO Severity Rating (Person) → DOTr Physical Condition code
SEVERITY_MAP = {
    'Fatal Injury (K)': 1,
    'Suspected Serious Injury (A)': 2,
    'Suspected Minor Injury (B)': 3,
    'Possible Injury (C)': 4,
    'No Apparent Injury (O)': 5,
}

# AASHTO Position in Vehicle → DOTr Position In/On Vehicle code
POSITION_MAP = {
    'Driver': 1,
    'Front Seat - Middle': 2,
    'Front Seat - Right Side': 3,
    'Middle Seat - Left Side': 4,
    'Middle Seat - Middle': 5,
    'Middle Seat - Right Side': 6,
    'Rear Seat - Left Side': 7,
    'Rear Seat - Middle': 8,
    'Rear Seat - Right Side': 9,
    'Bus Seating': 11,
    'Cargo Area': 12,
    'Riding/Hanging on Outside': 12,
    'Unknown': 0,
    'Not Applicable': 0,
}

# AASHTO Ejection → DOTr Ejection Code
EJECTION_MAP = {
    'Not Ejected': 1,
    'Partial Ejection': 2,
    'Ejected': 3,
    'Trapped': 4,
    'Not Applicable': 0,
    'Unknown': 0,
}

# AASHTO Sex → DOTr Sex
SEX_MAP = {
    'Male': 'M',
    'Female': 'F',
    'Non-Binary': 'X',
    'Unknown': '',
}


def build_crash_pk_lookup(aashto_crashes: pd.DataFrame, lookup: dict) -> pd.DataFrame:
    """Build crash_id → (cc, mc, case) lookup from AASHTO crashes.parquet."""
    cc_mc = aashto_crashes.apply(lambda r: lookup_cc_mc(lookup, r['County'], r['Municipality']), axis=1)
    out = pd.DataFrame({
        'crash_id': aashto_crashes['crash_id'],
        'cc': cc_mc.apply(lambda x: x[0]),
        'mc': cc_mc.apply(lambda x: x[1]),
        'case': aashto_crashes['Case Number'].astype(str),
    })
    return out.set_index('crash_id')


def normalize_age(age_series: pd.Series) -> pd.Series:
    """AASHTO uses 0 for unknown; DOTr uses blank/NaN. Map 0 → NaN."""
    age = pd.to_numeric(age_series, errors='coerce')
    age = age.where((age > 0) & (age <= 110))
    return age.astype('Int8')


def to_occupants(joined: pd.DataFrame, year: int) -> pd.DataFrame:
    """Convert AASHTO Driver/Passenger rows to DOTr-style occupants frame.

    Drops "ghost-Driver" rows (Driver Person Type + blank Position in
    Vehicle) — see module docstring."""
    occ_mask = joined['Person Type'].isin(['Driver', 'Passenger'])
    pos_blank = joined['Position in Vehicle'].isna() | (joined['Position in Vehicle'] == 'None')
    ghost_drivers = (joined['Person Type'] == 'Driver') & pos_blank
    n_ghost = ghost_drivers.sum()
    if n_ghost:
        err(f'        dropping {n_ghost:,} ghost-Driver rows (blank Position)')
    o = joined[occ_mask & ~ghost_drivers].copy()

    o['year'] = pd.Series(year, index=o.index, dtype='int32')
    # vehicle_index is 0-based in AASHTO; vn is 1-based in DOTr
    o['vn'] = (o['vehicle_index'].astype(int) + 1).astype('Int8')
    # Number occupants within (crash_id, vehicle_index) by AASHTO row order
    o = o.sort_values(['crash_id', 'vehicle_index', 'person_index'])
    o['on'] = (o.groupby(['crash_id', 'vehicle_index']).cumcount() + 1).astype('Int8')

    o['condition'] = o['Severity Rating (Person)'].map(SEVERITY_MAP).astype('Int8')
    o['pos'] = o['Position in Vehicle'].map(POSITION_MAP).astype('Int8')
    # Driver Person Type forces pos=1 (covers AASHTO 'Driver' position field being blank for some rows)
    o.loc[o['Person Type'] == 'Driver', 'pos'] = 1
    o['eject'] = o['Ejection'].map(EJECTION_MAP).astype('Int8')
    o['age'] = normalize_age(o['Age'])
    o['sex'] = o['Sex'].map(SEX_MAP).fillna('')

    cols = ['year', 'cc', 'mc', 'case', 'vn', 'on', 'condition', 'pos', 'eject', 'age', 'sex']
    return o[cols].reset_index(drop=True)


def to_pedestrians(joined: pd.DataFrame, year: int) -> pd.DataFrame:
    """Convert AASHTO Pedestrian/Pedalcyclist rows to DOTr-style pedestrians frame."""
    ped_mask = joined['Person Type'].isin(['Pedestrian', 'Pedalcyclist'])
    p = joined[ped_mask].copy()

    p['year'] = pd.Series(year, index=p.index, dtype='int32')
    p = p.sort_values(['crash_id', 'person_index'])
    p['pn'] = (p.groupby('crash_id').cumcount() + 1).astype('Int8')

    p['condition'] = p['Severity Rating (Person)'].map(SEVERITY_MAP).astype('Int8')
    p['cyclist'] = (p['Person Type'] == 'Pedalcyclist')
    p['age'] = normalize_age(p['Age'])
    p['sex'] = p['Sex'].map(SEX_MAP).fillna('')

    cols = ['year', 'cc', 'mc', 'case', 'pn', 'condition', 'cyclist', 'age', 'sex']
    return p[cols].reset_index(drop=True)


def process_year(year: int, in_dir: Path, lookup: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    crashes_path = in_dir / str(year) / 'crashes.parquet'
    persons_path = in_dir / str(year) / 'persons.parquet'
    if not crashes_path.exists() or not persons_path.exists():
        err(f'  skip {year}: missing {crashes_path} or {persons_path}')
        return None, None

    aashto_crashes = pd.read_parquet(crashes_path, columns=['crash_id', 'Case Number', 'County', 'Municipality'])
    aashto_persons = pd.read_parquet(persons_path)
    err(f'  {year}: {len(aashto_persons):,} persons across {len(aashto_crashes):,} crashes')

    pk_lookup = build_crash_pk_lookup(aashto_crashes, lookup)
    joined = aashto_persons.join(pk_lookup, on='crash_id', how='left')

    n_unmatched_pk = joined['cc'].isna().sum()
    if n_unmatched_pk:
        err(f'        {n_unmatched_pk:,} persons in crashes with no (cc, mc) lookup')

    occupants = to_occupants(joined, year)
    pedestrians = to_pedestrians(joined, year)
    err(f'        occupants: {len(occupants):,}, pedestrians: {len(pedestrians):,}')
    return occupants, pedestrians


@click.command()
@click.option('-y', '--years', default='2024,2025', help='Comma-separated years to process')
@click.option('-i', '--in-dir', type=click.Path(path_type=Path), default=Path('njdot/data'))
@click.option('-o', '--occupants-out', type=click.Path(path_type=Path),
              default=Path('njdot/data/aashto_supplemented_occupants.parquet'))
@click.option('-p', '--pedestrians-out', type=click.Path(path_type=Path),
              default=Path('njdot/data/aashto_supplemented_pedestrians.parquet'))
def main(years: str, in_dir: Path, occupants_out: Path, pedestrians_out: Path):
    lookup = load_cc2mc2mn()
    err(f'Loaded cc2mc2mn lookup: {len(lookup):,} (cn, mn) pairs')

    year_list = [int(y) for y in years.split(',')]
    occ_parts = []
    ped_parts = []
    for y in year_list:
        o, p = process_year(y, in_dir, lookup)
        if o is not None:
            occ_parts.append(o)
            ped_parts.append(p)

    if not occ_parts:
        err('No years to process.')
        return

    occupants = pd.concat(occ_parts, ignore_index=True)
    pedestrians = pd.concat(ped_parts, ignore_index=True)
    err(f'\nCombined: {len(occupants):,} occupants, {len(pedestrians):,} pedestrians')

    occupants_out.parent.mkdir(parents=True, exist_ok=True)
    occupants.to_parquet(occupants_out, index=False)
    err(f'Wrote {occupants_out}')

    pedestrians_out.parent.mkdir(parents=True, exist_ok=True)
    pedestrians.to_parquet(pedestrians_out, index=False)
    err(f'Wrote {pedestrians_out}')


if __name__ == '__main__':
    main()
