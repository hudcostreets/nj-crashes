"""
Aggregate NJDOT crash data into small parquet files for frontend visualization.

Generates aggregations like:
- ymccs: year, month, county, severity → counts/injuries/fatalities
- yms: year, month, severity → state-level totals
- etc.

Output files go to `www/public/data/njdot/` for hyparquet to load.
"""

from functools import reduce
from pathlib import Path

import click
import pandas as pd

from njdot.paths import (
    AASHTO_SUPPLEMENTED_CRASHES, AASHTO_SUPPLEMENTED_VEHICLES, CRASHES_PQT,
    WWW_DATA_DOT, OCCUPANTS_PQT, PEDESTRIANS_PQT, VEHICLES_PQT,
)


# Dimension columns
DIMS = {
    'y': 'year',
    'm': 'month',
    'cc': 'cc',
    'mc': 'mc',
    's': 'severity',
}

# Victim type × condition matrix columns
VICTIM_TYPES = ['d', 'o', 'p', 'b', 'u']  # driver, passenger, pedestrian, bicyclist, unknown
CONDITIONS = ['f', 's', 'm', 'p', 'n']     # fatal, serious, minor, possible, none
VTC_COLS = [f'{vt}{c}' for vt in VICTIM_TYPES for c in CONDITIONS]
CONDITION_MAP = {1: 'f', 2: 's', 3: 'm', 4: 'p', 5: 'n', 0: 'n'}

# Vehicle damage tiers (NJTR-1 "Extent of Damage"). Source codes: 1=None,
# 2=Minor, 3=Moderate, 4=Disabling. Data only exists 2017+; pre-2017 all NA →
# `vdu` (unknown).
VD_COLS = ['vdn', 'vdm', 'vdo', 'vdx', 'vdu']
DAMAGE_MAP = {1: 'vdn', 2: 'vdm', 3: 'vdo', 4: 'vdx'}

# Vehicle departure (NJTR-1 "Driven/Left/Towed"). Collapsed from 6 source
# codes to 3 buckets: 1=Driven (vepd), 2=Left at Scene (vepl),
# 3/4/5/6=Towed/any variant (vept). Unknown → `vepu`. Well-coded 2001+.
VEP_COLS = ['vepd', 'vepl', 'vept', 'vepu']
DEPARTURE_MAP = {1: 'vepd', 2: 'vepl', 3: 'vept', 4: 'vept', 5: 'vept', 6: 'vept'}

# Measure columns (aggregations)
# Include victim type × condition matrix (25 columns) + per-vehicle damage
# tiers (5) + departure buckets (4) for frontend filtering/stacking.
MEASURES = ['n', 'tk', 'ti', 'pk', 'pi', 'tv'] + VTC_COLS + VD_COLS + VEP_COLS


def _pos_to_vt(pos):
    """Driver / passenger / unknown classification from `pos` field."""
    if pd.isna(pos) or pos == 0:
        return 'u'
    return 'd' if pos == 1 else 'o'


def compute_legacy_vtc(occupants_path: Path, pedestrians_path: Path) -> pd.DataFrame:
    """Compute per-crash 25-col VTC matrix from legacy O/P master parquets.

    The legacy O/P parquets reference crashes by `crash_id` (== crashes
    parquet's row index, NOT (year, cc, mc, case)). This function aggregates
    person-level rows into 25 columns per `crash_id`.

    Filters person-level `condition` to the 1-5 range (1=Fatal, 5=No Apparent
    Injury); 0/null are dropped. Occupant `pos`: 1=driver, >1=passenger,
    0/null → unknown (`u`-prefixed cells). Pedestrian `cyclist` bool splits
    `p` vs `b` cells.
    """
    print(f"  Computing legacy VTC from {occupants_path.name} + {pedestrians_path.name}...")
    # Legacy O/P pre-2019: ~76% of occupant rows have `condition=NA` (DOTr
    # coding improved over time). Treat NA / 0 / out-of-range as 'n' (no
    # apparent injury) so those people still count as crash participants;
    # otherwise pre-2019 People bars would be artificially ~85% lower than
    # later years.
    o = pd.read_parquet(occupants_path, columns=['crash_id', 'pos', 'condition'])
    o['cond'] = o['condition'].map(CONDITION_MAP).fillna('n')
    o['vt'] = o['pos'].apply(_pos_to_vt)
    o['vtc'] = o['vt'] + o['cond']
    o_agg = o.groupby(['crash_id', 'vtc']).size().unstack(fill_value=0)

    p = pd.read_parquet(pedestrians_path, columns=['crash_id', 'cyclist', 'condition'])
    p['cond'] = p['condition'].map(CONDITION_MAP).fillna('n')
    p['vt'] = p['cyclist'].apply(lambda b: 'b' if b else 'p')
    p['vtc'] = p['vt'] + p['cond']
    p_agg = p.groupby(['crash_id', 'vtc']).size().unstack(fill_value=0)

    combined = o_agg.add(p_agg, fill_value=0)
    for col in VTC_COLS:
        if col not in combined.columns:
            combined[col] = 0
    combined = combined[VTC_COLS].fillna(0).astype('int32')
    print(f"    {len(combined):,} crashes with VTC; total cells = {combined.values.sum():,}")
    return combined


def compute_legacy_vehicle_facets(vehicles_path: Path) -> pd.DataFrame:
    """Compute per-crash damage tier + departure bucket counts from legacy
    `vehicles.parquet`.

    Returns a DataFrame indexed by `crash_id` with 9 columns: `vdn/vdm/vdo/
    vdx/vdu` (None/Minor/Moderate/Disabling/Unknown) and `vepd/vepl/vept/
    vepu` (Driven/Left/Towed/Unknown).

    Damage data only exists 2017+ (pre-2017 rows count toward `vdu`). The
    Departure field is well-coded 2001+ at ~87-95% coverage.
    """
    print(f"  Computing legacy vehicle facets from {vehicles_path.name}...")
    v = pd.read_parquet(vehicles_path, columns=['crash_id', 'damage', 'departure'])
    v['vd'] = v['damage'].map(DAMAGE_MAP).fillna('vdu')
    v['vep'] = v['departure'].map(DEPARTURE_MAP).fillna('vepu')

    vd_agg = v.groupby(['crash_id', 'vd']).size().unstack(fill_value=0)
    vep_agg = v.groupby(['crash_id', 'vep']).size().unstack(fill_value=0)
    combined = vd_agg.join(vep_agg, how='outer').fillna(0)
    for col in VD_COLS + VEP_COLS:
        if col not in combined.columns:
            combined[col] = 0
    combined = combined[VD_COLS + VEP_COLS].astype('int32')
    print(f"    {len(combined):,} crashes with vehicle rows; damage-tier cells: {combined[VD_COLS].sum().sum():,}; departure cells: {combined[VEP_COLS].sum().sum():,}")
    return combined


def compute_aashto_vehicle_facets(vehicles_path: Path) -> pd.DataFrame:
    """Compute per-crash damage + departure counts from the AASHTO vehicles
    supplement, keyed by `(year, cc, mc, case)`.

    The supplement uses the same `damage` and `departure` code conventions
    as legacy (`DAMAGE_MAP` / `DEPARTURE_MAP`); Departure coverage is low
    (~18%) because AASHTO's "Removed To" is mostly free-text placeholder
    rather than coded values.
    """
    print(f"  Computing AASHTO vehicle facets from {vehicles_path.name}...")
    v = pd.read_parquet(vehicles_path)
    v['vd'] = v['damage'].map(DAMAGE_MAP).fillna('vdu')
    v['vep'] = v['departure'].map(DEPARTURE_MAP).fillna('vepu')

    keys = ['year', 'cc', 'mc', 'case']
    vd_agg = v.groupby(keys + ['vd']).size().unstack(fill_value=0)
    vep_agg = v.groupby(keys + ['vep']).size().unstack(fill_value=0)
    combined = vd_agg.join(vep_agg, how='outer').fillna(0)
    for col in VD_COLS + VEP_COLS:
        if col not in combined.columns:
            combined[col] = 0
    combined = combined[VD_COLS + VEP_COLS].astype('int32')
    print(f"    {len(combined):,} crashes; damage cells: {combined[VD_COLS].sum().sum():,}; departure cells: {combined[VEP_COLS].sum().sum():,}")
    return combined.reset_index()


def load_crashes(path: Path, enrich_legacy_vtc: bool = False, enrich_legacy_vehicles: bool = False) -> pd.DataFrame:
    """Load crashes parquet and add month column.

    `enrich_legacy_vtc=True` merges VTC columns from legacy O/P masters via
    `crash_id` ↔ crashes index (only applies when the loaded parquet has no
    VTC of its own — pre-2023 master `crashes.parquet`).

    `enrich_legacy_vehicles=True` adds per-crash damage + departure buckets
    from `vehicles.parquet` (same crash_id join). No AASHTO equivalent for
    2024+ yet (see specs/vehicle-facets.md Phase 4).
    """
    import pyarrow.parquet as pq
    schema_cols = set(pq.read_schema(path).names)
    base_cols = ['year', 'cc', 'mc', 'case', 'dt', 'severity', 'tk', 'ti', 'pk', 'pi', 'tv']
    base_cols = [c for c in base_cols if c in schema_cols]  # 'case' is optional
    vtc_present = [c for c in VTC_COLS if c in schema_cols]
    if vtc_present:
        print(f"  VTC columns found: {len(vtc_present)}/{len(VTC_COLS)}")
    else:
        print(f"  No VTC columns in {path.name}, using basic measures only")
    df = pd.read_parquet(path, columns=base_cols + vtc_present)
    df['month'] = pd.to_datetime(df['dt']).dt.month
    df['n'] = 1  # count column
    for c in VTC_COLS + VD_COLS + VEP_COLS:
        if c not in df.columns:
            df[c] = 0

    # Enrich legacy crashes with VTC by joining O/P masters via crash_id
    # (== crashes.parquet row-index). No-op if VTC cols were already present.
    if enrich_legacy_vtc and not vtc_present:
        vtc = compute_legacy_vtc(Path(OCCUPANTS_PQT), Path(PEDESTRIANS_PQT))
        # crashes.parquet's RangeIndex is the crash_id used by O/P
        merged = df.join(vtc, how='left', rsuffix='_vtc')
        for c in VTC_COLS:
            vtc_col = f'{c}_vtc'
            if vtc_col in merged.columns:
                merged[c] = merged[vtc_col].fillna(0).astype('int32')
                merged = merged.drop(columns=[vtc_col])
        df = merged

    if enrich_legacy_vehicles:
        veh = compute_legacy_vehicle_facets(Path(VEHICLES_PQT))
        merged = df.join(veh, how='left', rsuffix='_veh')
        for c in VD_COLS + VEP_COLS:
            veh_col = f'{c}_veh'
            if veh_col in merged.columns:
                merged[c] = merged[veh_col].fillna(0).astype('int32')
                merged = merged.drop(columns=[veh_col])
        df = merged

    # Backfill: any crash with vehicles (tv > 0) that has no per-vehicle
    # facet data lands its whole `tv` count in `vdu`/`vepu`. This covers two
    # cases: AASHTO 2023+ crashes (no vehicles table yet — Phase 4) and the
    # rare legacy crash whose `crash_id` didn't match anything in
    # `vehicles.parquet`. Without this, those rows would render as height-0
    # bars when stacking by Damage/Departure, even though we know how many
    # vehicles were involved overall.
    vd_sum = df[VD_COLS].sum(axis=1)
    vep_sum = df[VEP_COLS].sum(axis=1)
    missing_vd = (vd_sum == 0) & (df['tv'] > 0)
    missing_vep = (vep_sum == 0) & (df['tv'] > 0)
    df.loc[missing_vd, 'vdu'] = df.loc[missing_vd, 'tv'].astype('int32')
    df.loc[missing_vep, 'vepu'] = df.loc[missing_vep, 'tv'].astype('int32')
    return df


BASE_MEASURES = ['n', 'tk', 'ti', 'pk', 'pi', 'tv']


def aggregate(df: pd.DataFrame, dims: list[str]) -> pd.DataFrame:
    """Aggregate crashes by given dimensions."""
    group_cols = [DIMS[d] for d in dims]
    agg_df = df.groupby(group_cols, as_index=False)[MEASURES].sum()
    # Rename columns to short names
    rename = {v: k for k, v in DIMS.items() if v in group_cols}
    agg_df = agg_df.rename(columns=rename)
    # Drop VTC columns that are all zero (not present in source data)
    for c in VTC_COLS:
        if c in agg_df.columns and (agg_df[c] == 0).all():
            agg_df = agg_df.drop(columns=[c])
    # Downcast numeric columns for smaller parquet files
    for c in agg_df.columns:
        if c in ('s',):
            continue
        if agg_df[c].dtype in ('int64', 'float64'):
            col_max = agg_df[c].max()
            if agg_df[c].dtype == 'float64' and (agg_df[c] == agg_df[c].astype(int)).all():
                agg_df[c] = agg_df[c].astype('int64')
            if col_max <= 127:
                agg_df[c] = agg_df[c].astype('int8')
            elif col_max <= 32767:
                agg_df[c] = agg_df[c].astype('int16')
            elif col_max <= 2147483647:
                agg_df[c] = agg_df[c].astype('int32')
    return agg_df


def write_parquet(df: pd.DataFrame, path: Path):
    """Write aggregation to parquet with snappy compression (hyparquet-compatible)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False, compression='snappy')
    size_kb = path.stat().st_size / 1024
    print(f"  {path.name}: {len(df):,} rows, {size_kb:.1f} KB, {len(df.columns)} cols")


def parse_dims(agg_name: str) -> list[str]:
    """Parse dimension codes from aggregation name.

    Handles multi-char codes like 'cc', 'mc'.
    E.g., 'ymccs' -> ['y', 'm', 'cc', 's']
    """
    dims = []
    i = 0
    while i < len(agg_name):
        # Check for two-char codes first
        if i + 1 < len(agg_name):
            two_char = agg_name[i:i+2]
            if two_char in DIMS:
                dims.append(two_char)
                i += 2
                continue
        # Single char
        dims.append(agg_name[i])
        i += 1
    return dims


# Predefined aggregation configs: name -> dimension list
AGG_CONFIGS = {
    'ys': ['y', 's'],                      # year, severity (state totals)
    'yms': ['y', 'm', 's'],                # year, month, severity
    'yccs': ['y', 'cc', 's'],              # year, county, severity
    'ymccs': ['y', 'm', 'cc', 's'],        # year, month, county, severity
    'ymccmc': ['y', 'm', 'cc', 'mc'],      # year, month, county, muni (most granular, no severity)
    'ymccmcs': ['y', 'm', 'cc', 'mc', 's'], # year, month, county, muni, severity (largest)
}


@click.command('agg')
@click.option('-i', '--input', 'input_path', default=CRASHES_PQT, help='Input crashes parquet (per-table 2001–2023)')
@click.option('-A', '--aashto-input', default=AASHTO_SUPPLEMENTED_CRASHES, help='AASHTO crashes parquet (with NJSP-only fatals supplemented in)')
@click.option('-o', '--output-dir', default=WWW_DATA_DOT, help='Output directory (default: `www/public/data/njdot`)')
@click.option('-a', '--aggs', default='ys,yms,yccs,ymccs,ymccmc,ymccmcs', help='Comma-separated list of aggregations to generate')
def agg(input_path: str, aashto_input: str, output_dir: str, aggs: str):
    """Generate aggregated parquet files for NJDOT crash data."""
    input_path = Path(input_path)
    aashto_input = Path(aashto_input)
    output_dir = Path(output_dir)

    print(f"Loading {input_path}...")
    # Legacy crashes.parquet has no VTC cols — enrich from O/P masters via
    # crash_id join, so pre-2023 years populate the 25-cell matrix. Also
    # join vehicles.parquet for per-crash damage/departure facets.
    df = load_crashes(input_path, enrich_legacy_vtc=True, enrich_legacy_vehicles=True)
    print(f"  {len(df):,} crashes loaded ({df['year'].min()}-{df['year'].max()})")

    if aashto_input.exists():
        print(f"Loading {aashto_input}...")
        aashto_df = load_crashes(aashto_input)
        print(f"  {len(aashto_df):,} crashes loaded ({aashto_df['year'].min()}-{aashto_df['year'].max()})")
        # Drop rows with cc/mc unresolved (small percentage; can't be
        # bucketed into per-county/per-muni aggregates).
        n_drop = aashto_df['cc'].isna().sum()
        if n_drop:
            print(f"  dropping {n_drop:,} AASHTO rows with unresolved (cc, mc)")
            aashto_df = aashto_df.dropna(subset=['cc'])

        # Enrich AASHTO with per-vehicle damage + departure facets from the
        # AASHTO vehicles supplement (`njdot aashto vehicles`). Keyed by
        # (year, cc, mc, case). Reset vd/vep cols first so we overwrite the
        # load_crashes backfill (which set vdu=tv for all AASHTO rows).
        aashto_veh_path = Path(AASHTO_SUPPLEMENTED_VEHICLES)
        if aashto_veh_path.exists():
            for c in VD_COLS + VEP_COLS:
                aashto_df[c] = 0
            veh_aashto = compute_aashto_vehicle_facets(aashto_veh_path)
            # Normalize join keys to matching dtypes
            aashto_df['cc'] = aashto_df['cc'].astype('Int8')
            aashto_df['mc'] = aashto_df['mc'].astype('Int16')
            aashto_df['case'] = aashto_df['case'].astype(str)
            veh_aashto['cc'] = veh_aashto['cc'].astype('Int8')
            veh_aashto['mc'] = veh_aashto['mc'].astype('Int16')
            veh_aashto['case'] = veh_aashto['case'].astype(str)
            merged = aashto_df.merge(
                veh_aashto, on=['year', 'cc', 'mc', 'case'], how='left', suffixes=('', '_a')
            )
            n_matched = 0
            for c in VD_COLS + VEP_COLS:
                a_col = f'{c}_a'
                if a_col in merged.columns:
                    if c == VD_COLS[0]:
                        n_matched = merged[a_col].notna().sum()
                    merged[c] = merged[a_col].fillna(0).astype('int32')
                    merged = merged.drop(columns=[a_col])
            print(f"  AASHTO vehicles supplement: matched {n_matched:,}/{len(merged):,} crashes")
            aashto_df = merged
        else:
            print(f"  (no AASHTO vehicles supplement at {aashto_veh_path}; skipping)")
        # Prefer AASHTO over per-table for any overlapping year — per-table
        # 2023 has a broad-vs-strict-fatal mismatch (severity='f' uses
        # broad def, tk uses strict), producing an impossible 0.93
        # deaths/fatal-crash ratio. AASHTO uses Fatal Crash Indicator
        # (NJSP-aligned).
        aashto_years = set(aashto_df['year'].dropna().astype(int))
        overlap = sorted(set(df['year'].dropna().astype(int)) & aashto_years)
        if overlap:
            print(f"  AASHTO supersedes per-table for: {overlap}")
            # AASHTO vehicles supplement (above) already populates vd/vep for
            # all AASHTO years including 2023. No need to transplant from
            # legacy.
            df = df[~df['year'].isin(aashto_years)]
        df = pd.concat([df, aashto_df], ignore_index=True)
        # Re-run the tv→vdu/vepu backfill across the concat'd df so any AASHTO
        # crash that didn't get a legacy match (e.g. 2024-2025, plus the ~1%
        # of 2023 with PK mismatches) still has its tv reflected in Unknown.
        vd_sum = df[VD_COLS].sum(axis=1)
        vep_sum = df[VEP_COLS].sum(axis=1)
        missing_vd = (vd_sum == 0) & (df['tv'] > 0)
        missing_vep = (vep_sum == 0) & (df['tv'] > 0)
        df.loc[missing_vd, 'vdu'] = df.loc[missing_vd, 'tv'].astype('int32')
        df.loc[missing_vep, 'vepu'] = df.loc[missing_vep, 'tv'].astype('int32')
        print(f"  combined: {len(df):,} crashes ({df['year'].min()}-{df['year'].max()})")
    else:
        print(f"  (no AASHTO input at {aashto_input}; skipping 2024+)")

    agg_list = [a.strip() for a in aggs.split(',')]

    print(f"\nGenerating {len(agg_list)} aggregations...")
    for agg_name in agg_list:
        if agg_name not in AGG_CONFIGS:
            print(f"  {agg_name}: unknown aggregation (available: {', '.join(AGG_CONFIGS.keys())})")
            continue
        dims = AGG_CONFIGS[agg_name]
        try:
            agg_df = aggregate(df, dims)
            # Split municipality-level files by county for faster loading
            if 'mc' in dims:
                county_dir = output_dir / agg_name
                county_dir.mkdir(parents=True, exist_ok=True)
                for cc_val in sorted(agg_df['cc'].unique()):
                    cc_df = agg_df[agg_df['cc'] == cc_val].drop(columns=['cc'])
                    write_parquet(cc_df, county_dir / f"{cc_val}.parquet")
                total_kb = sum(f.stat().st_size for f in county_dir.glob('*.parquet')) / 1024
                print(f"  {agg_name}/: {len(agg_df):,} rows total, {total_kb:.1f} KB across {len(agg_df['cc'].unique())} counties")
            else:
                write_parquet(agg_df, output_dir / f"{agg_name}.parquet")
        except KeyError as e:
            print(f"  {agg_name}: error {e}")

    print("\nDone!")
