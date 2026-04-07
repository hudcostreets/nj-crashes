import geopandas as gpd
import pandas as pd
from dataclasses import dataclass, asdict
from geopandas import sjoin
from math import sqrt
from numpy import nan
from pandas import isna
from typing import Union, Tuple, Optional
from utz import cached_property, DF, sxs, err

from nj_crashes.geo import is_nj_ll
from nj_crashes.muni_codes import update_mc, load_munis_geojson
from nj_crashes.sri.mp05 import get_mp05_map
from njdot.load import load_tbl, INDEX_NAME, pk_renames
from njdot.merge_dupes import merge_duplicates

Year = Union[str, int]
Years = Union[Year, list[Year]]

# Victim type × condition matrix columns
VICTIM_TYPES = ['d', 'o', 'p', 'b', 'u']  # driver, passenger, pedestrian, bicyclist, unknown
CONDITIONS = ['f', 's', 'm', 'p', 'n']     # fatal, serious, minor, possible, none
VTC_COLS = [f'{vt}{c}' for vt in VICTIM_TYPES for c in CONDITIONS]

# Map physical condition codes to single-char conditions
CONDITION_MAP = {
    1: 'f',   # Fatal Injury
    2: 's',   # Suspected Serious Injury
    3: 'm',   # Suspected Minor Injury
    4: 'p',   # Possible Injury
    5: 'n',   # No Apparent Injury
    0: 'n',   # Unknown → treat as no apparent
}


def compute_victim_counts(crashes_df: pd.DataFrame, years: list[int]) -> pd.DataFrame:
    """Compute victim type × condition counts by joining with pedestrians/occupants.

    Adds 25 columns (5 victim types × 5 conditions) to crashes_df:
    - df, ds, dm, dp, dn: drivers
    - of, os, om, op, on: passengers (occupants)
    - pf, ps, pm, pp, pn: pedestrians
    - bf, bs, bm, bp, bn: bicyclists
    - uf, us, um, up, un: unknown position
    """
    from njdot.load import load_tbl
    from njdot import pedestrians as peds_mod
    from njdot import occupants as occs_mod

    # Initialize all VTC columns to 0
    for col in VTC_COLS:
        crashes_df[col] = 0

    crash_pk = ['year', 'cc', 'mc', 'case']

    # Load raw pedestrians (only map_year_df, not map_df which normalizes with crashes)
    err("Loading raw pedestrians for victim counts...")
    peds = load_tbl(
        'pedestrians',
        years=years,
        renames=peds_mod.renames,
        astype=peds_mod.astype,
        cols=['year', 'cc', 'mc', 'case', 'condition', 'cyclist'],
        map_year_df=peds_mod.map_year_df,
    )
    err(f"  Loaded {len(peds):,} pedestrian records")

    # Load raw occupants (only map_year_df, not map_df which normalizes with crashes/vehicles)
    err("Loading raw occupants for victim counts...")
    occs = load_tbl(
        'occupants',
        years=years,
        renames=occs_mod.renames,
        astype=occs_mod.astype,
        cols=['year', 'cc', 'mc', 'case', 'condition', 'pos'],
        map_year_df=occs_mod.map_year_df,
    )
    err(f"  Loaded {len(occs):,} occupant records")

    # Map condition codes to single-char conditions
    peds['cond'] = peds['condition'].map(CONDITION_MAP).fillna('n')
    occs['cond'] = occs['condition'].map(CONDITION_MAP).fillna('n')

    # Pedestrians: split into pedestrians (p) and bicyclists (b)
    peds['vt'] = peds['cyclist'].apply(lambda x: 'b' if x else 'p')

    # Occupants: driver (pos=1), passenger (pos=2-12), unknown (pos=0 or null)
    def pos_to_vt(pos):
        if pd.isna(pos) or pos == 0:
            return 'u'
        elif pos == 1:
            return 'd'
        else:
            return 'o'
    occs['vt'] = occs['pos'].apply(pos_to_vt)

    # Create VTC column name for each record
    peds['vtc'] = peds['vt'] + peds['cond']
    occs['vtc'] = occs['vt'] + occs['cond']

    # Aggregate pedestrians by crash PK and VTC
    err("Aggregating pedestrian victim counts...")
    peds_agg = peds.groupby(crash_pk + ['vtc']).size().unstack(fill_value=0)
    # Ensure all VTC columns exist
    for col in VTC_COLS:
        if col not in peds_agg.columns:
            peds_agg[col] = 0
    peds_agg = peds_agg[VTC_COLS].reset_index()

    # Aggregate occupants by crash PK and VTC
    err("Aggregating occupant victim counts...")
    occs_agg = occs.groupby(crash_pk + ['vtc']).size().unstack(fill_value=0)
    for col in VTC_COLS:
        if col not in occs_agg.columns:
            occs_agg[col] = 0
    occs_agg = occs_agg[VTC_COLS].reset_index()

    # Merge victim counts into crashes
    err("Merging victim counts with crashes...")
    crashes_df = crashes_df.reset_index()

    # Merge pedestrian counts
    crashes_df = crashes_df.merge(
        peds_agg,
        on=crash_pk,
        how='left',
        suffixes=('', '_peds')
    )
    # Add pedestrian counts to totals
    for col in VTC_COLS:
        peds_col = f'{col}_peds'
        if peds_col in crashes_df.columns:
            crashes_df[col] = crashes_df[col] + crashes_df[peds_col].fillna(0).astype('int8')
            crashes_df = crashes_df.drop(columns=[peds_col])

    # Merge occupant counts
    crashes_df = crashes_df.merge(
        occs_agg,
        on=crash_pk,
        how='left',
        suffixes=('', '_occs')
    )
    # Add occupant counts to totals
    for col in VTC_COLS:
        occs_col = f'{col}_occs'
        if occs_col in crashes_df.columns:
            crashes_df[col] = crashes_df[col] + crashes_df[occs_col].fillna(0).astype('int8')
            crashes_df = crashes_df.drop(columns=[occs_col])

    crashes_df = crashes_df.set_index('id')

    # Compute derived totals from the matrix
    # tk = total killed = df + of + pf + bf + uf
    crashes_df['tk'] = (
        crashes_df['df'] + crashes_df['of'] + crashes_df['pf'] +
        crashes_df['bf'] + crashes_df['uf']
    ).astype('int8')

    # ti = total injured = sum of all serious + minor + possible injuries
    ti_cols = [f'{vt}{c}' for vt in VICTIM_TYPES for c in ['s', 'm', 'p']]
    crashes_df['ti'] = crashes_df[ti_cols].sum(axis=1).astype('int8')

    # pk = pedestrians killed = pf
    crashes_df['pk'] = crashes_df['pf'].astype('int8')

    # pi = pedestrians injured = ps + pm + pp
    crashes_df['pi'] = (crashes_df['ps'] + crashes_df['pm'] + crashes_df['pp']).astype('int8')

    err(f"  Computed victim counts: tk={crashes_df['tk'].sum():,}, ti={crashes_df['ti'].sum():,}")
    err(f"  DOT-provided totals:    tk0={crashes_df['tk0'].sum():,}, ti0={crashes_df['ti0'].sum():,}")

    return crashes_df


ksi_renames = {
    'Total Killed': 'tk0',        # DOT-provided, preserved for QC
    'Total Injured': 'ti0',       # DOT-provided, preserved for QC
    'Pedestrians Killed': 'pk0',  # DOT-provided, preserved for QC
    'Pedestrians Injured': 'pi0', # DOT-provided, preserved for QC
    'Total Vehicles Involved': 'tv',
}
ksi_cols = list(ksi_renames.values())
road_renames = {
    'SRI (Standard Route Identifier)': 'sri',
    'Mile Post': 'mp',
    'Crash Location': 'road',
    'Location Direction': 'road_direction',
    'Cross Street Name': 'cross_street',
}
road_cols = list(road_renames.values())
name_renames = {
    'County Name': 'cn',
    'Municipality Name': 'mn',
}
renames = {
    'Date': 'dt',
    **pk_renames,
    **name_renames,
    'County Code 0': 'cc0',
    'Municipality Code 0': 'mc0',
    'Police Department Code': 'pdc',
    'Police Department': 'pdn',
    'Police Station': 'station',
    'Latitude': 'olat',
    'Longitude': 'olon',
    'Crash Type Code': 'crash_type',
    'Severity': 'severity',
    **road_renames,
    **ksi_renames,
    'Alcohol Involved': 'alcohol',
    'HazMat Involved': 'hazmat',
    'Route': 'route',
    'Road System': 'road_system',
    'Road Character': 'road_character',
    'Road Surface Type': 'road_surface',
    'Surface Condition': 'surface_condition',
    'Light Condition': 'light_condition',
    'Environmental Condition': 'env_condition',
    'Road Divided By': 'road_divided',
    'Temporary Traffic Control Zone': 'ttcz',
    'Distance To Cross Street': 'cross_street_distance',
    'Ramp To/From Route Name': 'ramp_route',
    'Ramp To/From Direction': 'ramp_direction',
    'Posted Speed': 'speed_limit',
    'Posted Speed Cross Street': 'speed_limit_cross',
    'Cell Phone In Use Flag': 'cell_phone',
    'Road Horizontal Alignment': 'horizontal_alignment',
    'Road Grade': 'road_grade',
    'First Harmful Event': 'first_harmful_event',
}
astype = {
    'dt': '<M8[us]',
    'cc0': 'Int8',  # Nullable - only populated when geocoding changes PK
    'mc0': 'Int8',  # Nullable - only populated when geocoding changes PK
    'tk0': 'int8',  # DOT-provided total killed
    'ti0': 'int8',  # DOT-provided total injured
    'pk0': 'int8',  # DOT-provided pedestrians killed
    'pi0': 'int8',  # DOT-provided pedestrians injured
    'tv': 'int8',
    'crash_type': 'Int8',
    'road_system': 'Int8',
    'road_character': 'Int8',
    'road_surface': 'Int8',
    'surface_condition': 'Int8',
    'light_condition': 'Int8',
    'env_condition': 'Int8',
    'road_divided': 'Int8',
    'tmp_traffic_control_zone': 'Int8',
    'cross_street_distance': 'Int16',
    'horizontal_alignment': 'Int8',
    'road_grade': 'Int8',
    'first_harmful_event': 'Int8',
    'mp': 'float32',  # TODO: can be imprecise when casted to float64 (e.g. in JS; 0.38999998569488525 instead of 0.39)
}


def map_year_df(df: pd.DataFrame, year: int) -> pd.DataFrame:
    df = df.drop(columns=['cn', 'mn']).rename(columns={ 'mc': 'mc_dot' })
    df.index.name = 'id'

    # Fix 2023 regression: duplicate (cc, mc_dot, case) keys (5,745 records in 2023)
    # For 2023: Use smart ucase/tcase merge strategy (69.5% success rate)
    # For other years: Simple dedup (keep last) if any duplicates exist
    pk_cols = ['cc', 'mc_dot', 'case']
    dupe_mask = df.duplicated(pk_cols, keep=False)
    if dupe_mask.any():
        num_dupes = dupe_mask.sum()
        if year == 2023:
            # Use smart merge for 2023 (ucase/tcase strategy)
            err(f"crashes {year}: Merging {num_dupes} duplicate records using ucase/tcase strategy")
            # Note: columns have been renamed by this point
            text_fields = ['pdn', 'road', 'cross_street']
            # 'Direction From Cross Street' not in renames dict, so it keeps original name
            fillable_fields = ['sri', 'mp', 'cross_street', 'Direction From Cross Street']
            df = merge_duplicates(df, pk_cols, text_fields=text_fields, fillable_fields=fillable_fields)
        else:
            # Simple dedup for other years (shouldn't have duplicates, but handle gracefully)
            err(f"crashes {year}: Dropping {num_dupes} duplicate records (keeping last)")
            df = df[~df.duplicated(pk_cols, keep='last')]

    df = update_mc(df, 'dot', drop=False)
    df['pdn'] = df.pdn.apply(lambda pdn: pdn.title())
    df['olon'] = -df['olon']  # Longitudes all come in positive, but are actually supposed to be negative (NJ ⊂ [-76, -73])
    df['severity'] = df['severity'].apply(lambda s: s.lower())
    # Reclassify severity based on actual outcomes (fix data entry errors)
    # If there are fatalities, it's a fatal crash; if injuries (but no fatalities), it's an injury crash
    misclassified_fatal = (df['tk0'] > 0) & (df['severity'] != 'f')
    misclassified_injury = (df['ti0'] > 0) & (df['tk0'] == 0) & (df['severity'] == 'p')
    if misclassified_fatal.any():
        err(f"crashes {year}: Reclassifying {misclassified_fatal.sum()} crashes with fatalities to 'f' severity")
        df.loc[misclassified_fatal, 'severity'] = 'f'
    if misclassified_injury.any():
        err(f"crashes {year}: Reclassifying {misclassified_injury.sum()} crashes with injuries to 'i' severity")
        df.loc[misclassified_injury, 'severity'] = 'i'
    df['route'] = df['route'].replace('', nan).astype('Int16').replace(0, nan)
    df['ramp_route'] = df['ramp_route'].replace(r'^\?$', '', regex=True)
    for k in ['speed_limit', 'speed_limit_cross']:
        df[k] = df[k].replace('^(?:0|-1)?$', nan, regex=True).astype('Int8')
    df['cell_phone'] = df['cell_phone'].apply(lambda s: {'Y': True, 'N': False}[s])

    df.index = df.index.astype('int32')
    # Move `dt` column to the front
    df = df[['dt'] + [ c for c in df if c != 'dt' ]]

    mg = load_munis_geojson()
    err(f"crashes {year}: merging olat/olon with muni geometries")
    ogdf = Crashes(df).gdf('o')
    joined = sjoin(ogdf.df[['olat', 'olon', 'geometry']], mg)[['cc', 'mc']].rename(columns={
        'cc': 'occ',
        'mc': 'omc',
    })
    with_omc = (
        sxs(
            ogdf.df,
            joined.occ,
            joined.omc,
        )
        .sort_index()
        .drop(columns='geometry')
        .astype({
            'occ': 'Int8',
            'omc': 'Int8',
        })
    )

    err(f"crashes {year}: geocoding SRI/MPs")
    ill = Crashes(with_omc).mp_lls(append=True)
    err(f"crashes {year}: merging ilat/ilon with muni geometries")
    igdf = Crashes(ill).gdf('i')
    ij = sjoin(igdf.df[['geometry']], mg)[['cc', 'mc']].rename(columns={
        'cc': 'icc',
        'mc': 'imc',
    })
    dupe_mask = ij.index.duplicated(keep=False)
    dupe_idxs = ij.index[ dupe_mask]
    uniq_idxs = ij.index[~dupe_mask]
    dupes = ij.loc[dupe_idxs]
    uniqs = ij.loc[uniq_idxs]

    cols = ['id', 'cc', 'mc']
    recovered = (
        dupes
        .reset_index()
        .drop_duplicates()
        .rename(columns={ 'icc': 'cc', 'imc': 'mc', })
        .merge(
            df.reset_index()[cols],
            on=cols,
        )
        .set_index('id')
        .rename(columns={ 'cc': 'icc', 'mc': 'imc', })
    )
    if not dupes.empty:
        dupe_hist = dupes.index.value_counts().value_counts().to_dict()
        err(f"Recovered {len(recovered)} (ilat/ilon) / (cc,mc) pairs from {len(dupes)} duplicate mappings ({dupe_hist})")

    ij_deduped = pd.concat([ uniqs, recovered ]).sort_index()
    assert not ij_deduped.index.duplicated().any()
    with_imc = (
        sxs(
            igdf.df,
            ij_deduped.icc,
            ij_deduped.imc,
        )
        .sort_index()
        .drop(columns='geometry')
        .astype({
            'icc': 'Int8',
            'imc': 'Int8',
        })
    )
    return with_imc


def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        pqt_path: Optional[str] = None,
        n_jobs: int = 0,
        cols: Optional[list[str]] = None,
        export_pk_mapping: bool = False,
        compute_victims: bool = False,
) -> pd.DataFrame:
    df = load_tbl(
        tbl='crashes',
        years=years,
        county=county,
        renames=renames,
        astype=astype,
        cols=cols,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        pqt_path=pqt_path,
        n_jobs=n_jobs,
        map_year_df=map_year_df,
    )

    # Export PK mapping table for V/D/O/P to fix their denormalized cc/mc
    if export_pk_mapping or write_pqt:
        from njdot.paths import DOT_DATA
        mapping_path = f'{DOT_DATA}/crash_pk_mappings.parquet'

        # Extract mapping: (year, cc0, mc0, case) → (cc, mc)
        # Only include rows where cc/mc changed (optimization)
        mapping = df[['year', 'cc0', 'mc0', 'case', 'cc', 'mc']].copy()
        changed = (mapping['cc0'] != mapping['cc']) | (mapping['mc0'] != mapping['mc'])
        mapping_changed = mapping[changed]

        err(f"Exporting PK mapping table: {len(mapping_changed):,} changed PKs (out of {len(mapping):,} total)")
        mapping.to_parquet(mapping_path, index=False)
        err(f"Wrote {mapping_path}")

    # Compute victim type × condition matrix from pedestrians/occupants
    if compute_victims or write_pqt:
        loaded_years = sorted(df['year'].unique().tolist())
        err(f"Computing victim counts for years: {loaded_years[0]}-{loaded_years[-1]}")
        df = compute_victim_counts(df, loaded_years)

    return df


def geocode_mp(r, sris):
    sri = r.sri
    mp = r.mp
    if isna(sri):
        return dict(reason="No SRI")
    if isna(mp):
        return dict(reason="No MP")
    if sri not in sris:
        return dict(reason='SRI not found')
    mp_lls = sris[sri]
    ll = mp_lls.get(mp)
    if ll:
        return asdict(ll)
    else:
        return dict(reason="MP didn't geocode")


@dataclass
class Crashes:
    df: pd.DataFrame

    @classmethod
    def load(cls, *args, **kwargs) -> 'Crashes':
        return cls(load(*args, **kwargs))

    def gdf(self, tpe='') -> 'Crashes':
        df = self.df
        gdf = gpd.GeoDataFrame(
            df,
            geometry=gpd.points_from_xy(x=df[f'{tpe}lon'], y=df[f'{tpe}lat']),
            columns=df.columns,
        ).astype(df.dtypes)
        gdf.index.name = INDEX_NAME
        return Crashes(gdf)

    def mp_lls(self, append=True) -> pd.DataFrame:
        df = self.df
        mp05_map = get_mp05_map()
        ll = DF(
            sxs(df.sri, df.mp).apply(geocode_mp, sris=mp05_map, axis=1).tolist(),
            index=df.index,
        ).rename(columns={
            'lat': 'ilat',
            'lon': 'ilon',
        })
        if append:
            return sxs(df, ll)
        else:
            return ll

    def lls(self, default='io', types=None) -> 'LLCrashes':
        if types is None:
            # - interpolated (from SRI/MP)
            # - original (from crash report)
            # - interpolated, fall back to original
            # - original, fall back to interpolated
            types = [ 'oi' ]
            # types = [ 'i', 'o', 'io', 'oi', ]

        df = self.df.copy()
        mp05_map = get_mp05_map()
        ll = DF(sxs(df.sri, df.mp).apply(geocode_mp, sris=mp05_map, axis=1).tolist(), index=df.index)

        n = len(df)
        if len(ll) != n:
            raise RuntimeError(f"Expected {n} geocoded lls, got {len(ll)}")

        def replace(k, cross_tab=None):
            o = df[k].copy()
            i = ll[k]
            no_o = o.isna()
            yes_o = ~no_o
            num_no_o = no_o.sum()
            no_i = i.isna()
            yes_i = ~no_i
            num_yes_i = yes_i.sum()

            if cross_tab or (cross_tab is None and k == 'lat'):
                cross_tab_o = yes_o.apply(lambda b: "yes" if b else "no").rename("Original")
                cross_tab_i = yes_i.apply(lambda b: "yes" if b else "no").rename("Interpolated")
                crosstab = pd.crosstab(cross_tab_o, cross_tab_i)
                crosstab_pct = round(crosstab / n * 100, 1)
                err(f"Original {k} vs. interpolated {k}:")
                err(str(crosstab_pct))

            # Original lat/lon
            if 'o' in types:
                df[f'o{k}'] = o

            # Interpolated lat/lon
            if 'i' in types:
                df[f'i{k}'] = i

            # Original lat/lon, fall back to interpolated
            io = i.copy()
            io.loc[yes_o & no_i] = o
            if 'io' in types:
                df[f'io{k}'] = io

            # Interpolated lat/lon, fall back to original
            oi = o.copy()
            oi.loc[no_o & yes_i] = i
            if 'oi' in types:
                df[f'oi{k}'] = oi

            default_col = { 'i': i, 'o': o, 'io': io, 'oi': oi }[default]
            df[k] = default_col

        replace('lat')
        replace('lon')
        df = df[~df.lon.isna()]
        return LLCrashes(df)

    def __getattr__(self, item):
        return getattr(self.df, item)

    def __len__(self):
        return len(self.df)

    def __getitem__(self, item):
        return self.df[item]

    def __repr__(self):
        return repr(self.df)

    def _repr_html_(self):
        return self.df._repr_html_()


@dataclass
class LLCrashes(Crashes):
    df: pd.DataFrame

    @cached_property
    def nj_mask(self) -> pd.Series:
        return self.df.apply(lambda r: is_nj_ll(r.lat, r.lon), axis=1)

    @cached_property
    def njs(self) -> Tuple[pd.DataFrame, pd.DataFrame]:
        df = self.df
        nj_mask = self.nj_mask
        nnj = df[~nj_mask]
        nj = df[nj_mask]
        return nj, nnj

    @cached_property
    def nj(self) -> 'LLCrashes':
        return LLCrashes(self.njs[0])

    @cached_property
    def nnj(self) -> 'LLCrashes':
        return LLCrashes(self.njs[1])

    @cached_property
    def ll_hist(self):
        lls_count = self[['lon', 'lat', 'severity']].value_counts().rename('lls_count')
        merged = self.merge(lls_count.reset_index(), on=['lon', 'lat', 'severity'], how='left')
        merged['lls_count'] = merged['lls_count'].fillna(0)
        merged['radius'] = merged.lls_count.apply(sqrt)
        return LLCrashes(merged)
