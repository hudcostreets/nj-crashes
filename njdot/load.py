#!/usr/bin/env python
from os import stat, cpu_count
from os.path import exists

import pandas as pd
from humanize import naturalsize
from inspect import getfullargspec
from numpy import nan
from pandas import read_parquet
from typing import Union, Optional, Callable, Protocol
from utz import err, sxs

from njdot import NJDOT_DIR
from njdot.data import YEARS, cn2cc
from njdot.paths import AASHTO_SUPPLEMENTED_CRASHES, CRASHES_GEOCODE_BACKFILL, CRASHES_PQT, DOT_DATA
from njdot.tbls import Tbl, TBL_TO_TYPE, Type

Year = int
Years = Union[Year, list[Year]]

INDEX_NAME = 'id'
pk_renames = {
    'County Code': 'cc',
    'Municipality Code': 'mc',
    'Department Case Number': 'case',
}
pk_base = ['year'] + list(pk_renames.values())
pk_astype = {
    'cc': 'int8',
    'mc': 'int8',
    'year': 'int16',
}


def print_hists(df: pd.DataFrame, cols: Optional[list[str]] = None):
    for k in df:
        if cols is None or k in cols:
            print(df[k].value_counts(dropna=False).sort_index())


class Collable(Protocol):
    def __call__(self, cols: list[str]) -> pd.DataFrame:
        ...


class MapYearDF1(Protocol):
    def __call__(self, df: pd.DataFrame) -> pd.DataFrame:
        ...


class MapYearDF2(Protocol):
    def __call__(self, df: pd.DataFrame, year: int) -> pd.DataFrame:
        ...


def normalize(
        df: pd.DataFrame,
        id: str,
        r_fn: Collable,
        drop: bool = True,
        cols: Optional[list[str]] = None
) -> pd.DataFrame:
    if cols:
        left_on = right_on = cols
    else:
        left_on = pk_base
        right_on = [ 'mc_dot' if c == 'mc' else c for c in pk_base ] if id == 'crash_id' else pk_base

    dfb = df[left_on]
    r = r_fn(cols=right_on)
    r_for_merge = r.reset_index().rename(columns={ 'id': id })

    # Check for duplicate keys in right dataset before merging
    r_dupes = r_for_merge.groupby(right_on).size()
    r_dupes = r_dupes[r_dupes > 1]
    if len(r_dupes) > 0:
        err(f"WARNING: Right dataset has {len(r_dupes):,} duplicate keys on {right_on}")
        err(f"Sample duplicates: {list(r_dupes.head(3).items())}")

    m = dfb.merge(
        r_for_merge,
        left_on=left_on,
        right_on=right_on,
        how='left',
        # Removing validate='m:1' since it's failing even though manual checks show no duplicates
        # validate='m:1',
    )
    if drop:
        drop_cols = [ c for c in set(left_on + right_on) if c in df ]
        err(f"Dropping cols: {drop_cols}")
        df = df.drop(columns=drop_cols)
    dfm = sxs(m[id], df)
    dfm.index.name = INDEX_NAME

    # Ensure ID column is Int32 (nullable for safety, though should be required)
    # Using Int32 instead of int64/float64 saves space and displays cleanly
    if id in dfm.columns:
        dfm[id] = dfm[id].astype('Int32')

    return dfm


def load_year_df(
        year: int,
        typ: Type,
        tbl: str,
        renames: dict[str, str],
        astype: dict[str, Union[str, type]],
        opt_ints: dict[str, str],
        county: str,
        map_year_df: Union[None, MapYearDF1, MapYearDF2] = None,
):
    df = read_parquet(f'{NJDOT_DIR}/data/{year}/NewJersey{year}{typ}.pqt')

    # Preserve original line number for smart merge (before index gets reset during sorting)
    # This is needed for tracing V/O duplicates back to their source crash version
    df['_orig_lineno'] = df.index + 2  # 1-based + header

    # Fix 2023 regression: "Distance To Cross Street" has unnecessary decimal formatting
    # 2001-2022: clean integers ('50', '100')
    # 2023: decimal formatting ('50.0', '0.00', '100.', etc.)
    # See njdot/README.md #5 for details
    DISTANCE_FIELD = 'Distance To Cross Street'
    if DISTANCE_FIELD in df:
        field = df[DISTANCE_FIELD]
        if field.dtype in ['object', 'string']:
            # Find values with decimals
            has_decimal = field.astype(str).str.contains(r'\.\d', regex=True, na=False)
            if has_decimal.any():
                decimal_vals = field[has_decimal].astype(float)

                # Check for non-zero fractional parts
                has_fraction = (decimal_vals % 1 != 0)
                if has_fraction.any():
                    fractional_vals = decimal_vals[has_fraction]
                    frac_hist = fractional_vals.value_counts().to_dict()

                    # Expected fractional values (from 2023 analysis)
                    expected = {0.5: 2, 2.7: 1}
                    if frac_hist != expected:
                        err(f"WARNING: {tbl} {year}: Unexpected fractional values in '{DISTANCE_FIELD}'")
                        err(f"  Expected: {expected}")
                        err(f"  Found:    {frac_hist}")
                    else:
                        err(f"{tbl} {year}: Stripping decimals from '{DISTANCE_FIELD}': "
                            f"{has_decimal.sum()} values ({has_fraction.sum()} fractional: {frac_hist})")

                # Strip all trailing decimals (including fractional parts)
                df[DISTANCE_FIELD] = field.astype(str).str.replace(r'\.\d*$', '', regex=True).replace('nan', nan).replace('', nan)

    # Fix 2023 regression: Number fields have non-numeric values
    # 2001-2022: clean integers ('1', '2', '01', '02')
    # 2023: various patterns ('V1', 'V2', 'O1', 'P1', etc.)
    NUMBER_FIELDS = ['Vehicle Number', 'Occupant Number', 'Pedestrian Number']
    for NUMBER_FIELD in NUMBER_FIELDS:
        if NUMBER_FIELD not in df:
            continue
        field = df[NUMBER_FIELD]
        if field.dtype not in ['object', 'string']:
            continue

        # Find non-numeric values
        non_numeric = ~field.str.match(r'^[0-9]+$', na=False)
        if not non_numeric.any():
            continue

        non_numeric_vals = field[non_numeric]
        hist = non_numeric_vals.value_counts().to_dict()

        # Clean by stripping letter prefixes and removing other non-digits
        cleaned = field.copy()

        # First, detect and nullify hex-corrupted values (2023 data quality issue)
        # Pure hex strings like 'bf', 'f2', '7e' that aren't valid decimal numbers
        hex_pattern = cleaned.str.match(r'^[0-9a-f]{1,2}$', na=False)
        has_hex_chars = cleaned.str.contains(r'[a-f]', case=False, na=False, regex=True)
        hex_corrupted = hex_pattern & has_hex_chars
        if hex_corrupted.any():
            cleaned = cleaned.where(~hex_corrupted, nan)

        cleaned = cleaned.str.replace('!', '1', regex=False)  # ! → 1 (data entry error, holding shift)
        cleaned = cleaned.str.replace(r'^[A-Z]', '', regex=True)  # V1/O1/P1 → 1
        cleaned = cleaned.str.replace(r'[^0-9]', '', regex=True)  # Remove other non-digits
        cleaned = cleaned.replace('', nan)  # Empty string → NaN

        err(f"{tbl} {year}: Cleaning non-numeric '{NUMBER_FIELD}': {non_numeric.sum()} values")
        err(f"  Histogram: {hist}")

        df[NUMBER_FIELD] = cleaned

    # Clean invalid coded values from all object columns before type conversion
    # These appear in various coded fields (esp. Insurance Company Code in 2022-2023)
    # Use regex to match case-insensitively and handle whitespace
    for col in df.columns:
        if df[col].dtype == 'object':
            # Replace invalid values: UNK/unk, UNKNOWN/unknown, ?, **, *, etc.
            df[col] = df[col].str.strip().replace(
                r'(?i)^(unk|unknown|\?|\*+)$', '', regex=True
            )

    df = df.rename(columns=renames)

    df = df.astype({ k: v for k, v in astype.items() if k in df })
    for k, v in opt_ints.items():
        if k in df:
            # Use to_numeric to handle any invalid values gracefully
            if df[k].dtype == 'object':
                df[k] = pd.to_numeric(df[k], errors='coerce')
            df[k] = df[k].replace(r'^[\?\*]?$', nan, regex=True).replace('0?', '00', regex=False).replace('nan', nan).replace('', nan)
            # For float64, manually convert to nullable integer to avoid casting errors
            if df[k].dtype == 'float64':
                import numpy as np
                mask = pd.isna(df[k])
                rounded = df[k].fillna(0).round().astype('int64')
                df[k] = pd.arrays.IntegerArray(rounded.values, mask.values).astype(v)
            else:
                df[k] = df[k].astype(v)

    if county:
        df = df[df.cn.str.lower() == county.lower()]

    if 'year' in df:
        years_col = df.year
    else:
        years_col = df.dt.dt.year.rename('year')
        df['year'] = years_col

    wrong_year = years_col != int(year)
    if wrong_year.any():
        num_wrong_year = wrong_year.sum()
        err(f'{num_wrong_year} {tbl} for year {year} have wrong year: {years_col.value_counts()}')

    if map_year_df:
        spec = getfullargspec(map_year_df)
        kwargs = dict(year=year) if 'year' in spec.args else {}
        df = map_year_df(df, **kwargs)

    return df


def load_tbl(
        tbl: Tbl,
        years: Years = None,
        county: str = None,
        n_jobs: int = 0,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        pqt_path: Optional[str] = None,
        renames: Optional[dict[str, str]] = None,
        astype: Optional[dict[str, Union[str, type]]] = None,
        pk_cols: Optional[list[str]] = None,
        cols: Optional[list[str]] = None,
        map_year_df: Union[None, MapYearDF1, MapYearDF2] = None,
        map_df: Optional[Callable[[pd.DataFrame], pd.DataFrame]] = None,
) -> pd.DataFrame:
    if isinstance(years, str):
        years = list(map(int, years.split(',')))
    elif isinstance(years, int):
        years = [years]
    elif years is None:
        years = YEARS

    typ = TBL_TO_TYPE[tbl]

    pqt_path = pqt_path or f'{DOT_DATA}/{tbl}.parquet'
    if read_pqt or (read_pqt is None and exists(pqt_path) and not write_pqt):
        err(f"Reading {pqt_path}")
        df = read_parquet(pqt_path, columns=cols)
        if years != YEARS:
            df = df[df.year.isin(years)]
        if county:
            cc = cn2cc[county.title()]
            df = df[df.cc == cc]
        return df
    else:
        err("Computing")

    renames = { **pk_renames, **(renames or {}) }
    astype = { **pk_astype, **(astype or {}) }
    opt_ints = {
        k: v
        for k, v in astype.items()
        if isinstance(v, str) and v.startswith('Int')
    }
    astype = {
        k: v
        for k, v in astype.items()
        if k not in opt_ints
    }
    kwargs = dict(
        typ=typ,
        tbl=tbl,
        renames=renames,
        astype=astype,
        opt_ints=opt_ints,
        county=county,
        map_year_df=map_year_df,
    )
    if len(years) > 1 and n_jobs != 1:
        from joblib import Parallel, delayed
        if not n_jobs:
            n_jobs = cpu_count()
        err(f"Parallelizing {len(years)} years {n_jobs} ways")
        dfs = Parallel(n_jobs=n_jobs)(
            delayed(load_year_df)(year=year, **kwargs)
            for year in years
        )
    else:
        dfs = [
            load_year_df(year=year, **kwargs)
            for year in years
        ]

    df = pd.concat(dfs)

    pk_cols = pk_cols or []
    pk_cols = pk_base + pk_cols
    df = df.sort_values(pk_cols).reset_index(drop=True)
    # Reorder columns (pk_cols first), but don't filter yet - map_df might create new columns
    reorder_cols = pk_cols + [ col for col in df if col not in pk_cols ]
    df = df[reorder_cols]
    df.index.name = INDEX_NAME

    if map_df:
        df = map_df(df)

    # Filter to requested columns after map_df (which may create columns like crash_id)
    if cols:
        df = df[cols]

    # Clean up temporary columns added during processing
    df = df.drop(columns=['_orig_lineno'], errors='ignore')

    if write_pqt:
        df.to_parquet(pqt_path)
        size = stat(pqt_path).st_size
        err(f"Wrote {pqt_path} ({len(df)} rows, {naturalsize(size)})")

    return df


CRASH_IDXS = [
    ('severity', 'dt', 'cc', 'mc'),
    ('cc', 'severity', 'dt'),
    ('cc', 'mc', 'severity', 'dt'),
    ('severity', 'ilat', 'ilon'),
    ('severity', 'icc', 'dt'),
    ('dt', 'severity'),  # enables ORDER BY dt DESC with severity filter, avoids TEMP B-TREE
]


def load_crashes_with_aashto(columns: Optional[list[str]] = None) -> pd.DataFrame:
    """NJDOT 2001-2022 + AASHTO 2023+ (when present), columns normalized to NJDOT.

    AASHTO supersedes per-table for any year it covers — the per-table 2023
    fatal-flag bug surfaced this need (per-table over-counts fatals when broad-
    matched and under-counts when strict-matched; AASHTO has authoritative
    counts). Change this function to change the policy in every caller.

    If `crashes_geocode_backfill.parquet` exists, NJSP-recovered
    `(sri, mp, ilat, ilon)` rows are merged in (filling NaNs only) so
    fatals without an original geocode still get placed on the map.
    """
    err(f'Loading {CRASHES_PQT}...')
    df = read_parquet(CRASHES_PQT, columns=columns)
    err(f'  per-table: {len(df):,} crashes ({df["year"].min()}–{df["year"].max()})')
    if exists(AASHTO_SUPPLEMENTED_CRASHES):
        aashto = read_parquet(AASHTO_SUPPLEMENTED_CRASHES, columns=columns)
        err(f'  AASHTO:    {len(aashto):,} crashes ({int(aashto["year"].min())}–{int(aashto["year"].max())})')
        aashto_years = set(aashto['year'].dropna().astype(int))
        overlap = sorted(set(df['year'].dropna().astype(int)) & aashto_years)
        if overlap:
            err(f'  AASHTO supersedes per-table for: {overlap}')
            df = df[~df['year'].isin(aashto_years)]
        df = pd.concat([df, aashto], ignore_index=True)
        err(f'  combined: {len(df):,} crashes ({df["year"].min()}–{df["year"].max()})')
    else:
        err(f'  (no AASHTO at {AASHTO_SUPPLEMENTED_CRASHES}; per-table only)')
    # Backfill geocodes via NJSP MP-table lookup for rows that lack both
    # `(olat, olon)` and `(ilat, ilon)`. Sidecar produced by
    # `njdot backfill_geocodes`. Only sets columns the caller requested.
    if exists(CRASHES_GEOCODE_BACKFILL):
        backfill = read_parquet(CRASHES_GEOCODE_BACKFILL)
        df = _apply_geocode_backfill(df, backfill)
    return df


def _apply_geocode_backfill(df: pd.DataFrame, backfill: pd.DataFrame) -> pd.DataFrame:
    """Fillna `(sri, mp, ilat, ilon)` on `df` from `backfill`, joining on
    `(year, cc, mc, case)`. Columns missing from `df` (because the caller
    didn't request them) are skipped silently."""
    join_keys = ['year', 'cc', 'mc', 'case']
    if not all(k in df.columns for k in join_keys):
        return df
    fill_cols = [c for c in ('sri', 'mp', 'ilat', 'ilon') if c in df.columns]
    if not fill_cols:
        return df
    bf = backfill[join_keys + fill_cols].rename(columns={c: f'{c}_bf' for c in fill_cols})
    # Align dtypes on join keys; backfill writes Python ints, df may use Int8/Int16.
    for k in ('year', 'cc', 'mc'):
        if k in df.columns:
            bf[k] = bf[k].astype(df[k].dtype)
    merged = df.merge(bf, on=join_keys, how='left')
    n_applied = 0
    for c in fill_cols:
        bf_col = f'{c}_bf'
        # Only fill where original is NaN; otherwise preserve.
        mask = merged[c].isna() & merged[bf_col].notna()
        n_applied = max(n_applied, int(mask.sum()))
        merged.loc[mask, c] = merged.loc[mask, bf_col]
        merged = merged.drop(columns=[bf_col])
    err(f'  geocode backfill: applied to {n_applied:,} rows')
    return merged
