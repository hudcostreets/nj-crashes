from functools import cache
from os.path import exists

import pandas as pd
from typing import Literal
import geopandas as gpd
from utz import run

from nj_crashes.paths import MUNIS_GEOJSON, relpath


@cache
def load_munis_geojson() -> gpd.GeoDataFrame:
    if not exists(MUNIS_GEOJSON):
        run('dvc', 'pull', relpath(MUNIS_GEOJSON))
    gdf = gpd.read_file(MUNIS_GEOJSON)
    gdf['cc'] = gdf.MUN_CODE.str[:2].astype(int)
    gdf['mc'] = gdf.MUN_CODE.str[2:].astype(int)
    return gdf.set_index(['cc', 'mc'])


def update_mc(df: pd.DataFrame, tpe: Literal['sp', 'dot'], drop: bool = True) -> pd.DataFrame:
    if tpe == 'sp':
        import njsp
        mc_pqt_path = njsp.paths.MC_PQT
    else:
        import njdot
        mc_pqt_path = njdot.paths.MC_PQT

    mc_map = pd.read_parquet(mc_pqt_path)
    mc_col = f'mc_{tpe}'
    idx_col = df.index.name
    if idx_col is None:
        raise RuntimeError("DataFrame must have an index name")

    # Year-aware merge: defaults (year=NULL) + year-specific overrides
    has_year_df = 'year' in df.columns
    has_year_map = 'year' in mc_map.columns

    if has_year_df and has_year_map:
        # Two-step merge:
        # 1. Merge with defaults (year is NULL)
        mc_defaults = mc_map[mc_map['year'].isna()][['cc', mc_col, 'mc_gin']].dropna(subset=mc_col)
        # 2. Merge with year-specific overrides (year is NOT NULL)
        mc_overrides = mc_map[mc_map['year'].notna()][['cc', mc_col, 'year', 'mc_gin']].dropna(subset=mc_col)

        m = (
            df
            .reset_index()
            # First apply defaults (gets 'mc_gin' column)
            .merge(mc_defaults, on=['cc', mc_col], how='left', validate='m:1')
            # Then apply year-specific overrides (defaults 'mc_gin' → 'mc_gin_left', overrides → 'mc_gin')
            .merge(mc_overrides, on=['cc', mc_col, 'year'], how='left', validate='m:1', suffixes=['_left', ''])
            .set_index(idx_col)
        )
        # Use override if available, otherwise use default
        m['mc'] = m['mc_gin'].fillna(m['mc_gin_left'])
        m = m.drop(columns=['mc_gin', 'mc_gin_left'])
    else:
        # Simple merge without year awareness
        on = ['cc', mc_col]
        mc_simple = mc_map[on + ['mc_gin']].dropna(subset=mc_col)
        m = (
            df
            .reset_index()
            .merge(mc_simple, on=on, how='left', validate='m:1')
            .set_index(idx_col)
            .rename(columns={ 'mc_gin': 'mc', })
        )

    missing = m[m.mc.isna()]
    if not missing.empty:
        missing_hist = missing[['cc', mc_col]].value_counts().sort_index()
        raise RuntimeError(f"Missing {mc_col} for {len(missing_hist)} (cc,mc) pairs:\n{missing_hist}")

    if drop:
        m = m.drop(columns=mc_col)
    return m
