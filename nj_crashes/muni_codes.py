import pandas as pd
from typing import Literal


def update_mc(df: pd.DataFrame, tpe: Literal['sp', 'dot'], drop: bool = True) -> pd.DataFrame:
    if tpe == 'sp':
        import njsp
        mc_pqt_path = njsp.paths.MC_PQT
    else:
        import njdot
        mc_pqt_path = njdot.paths.MC_PQT

    mc_map = pd.read_parquet(mc_pqt_path)
    mc_col = f'mc_{tpe}'
    on = ['cc', mc_col]
    idx_col = df.index.name
    if idx_col is None:
        raise RuntimeError("DataFrame must have an index name")
    m = (
        df
        .reset_index()
        .merge(mc_map[on + ['mc_gin']].dropna(subset=mc_col), on=on, how='left', validate='m:1')
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
