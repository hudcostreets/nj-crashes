import numpy as np
import simplejson
from numpy import nan
from utz import err


def factor_col(df, col):
    vals = df[col].unique()
    if vals.dtype == np.dtype('float64'):
        isnan = np.isnan(vals)
        has_nan = isnan.any()
        vals = list(sorted(vals[~isnan]))
        if has_nan:
            vals.append(nan)
    else:
        vals = list(sorted(vals.tolist()))
    val2idx = { val: idx for idx, val in enumerate(vals) }
    df[col] = df[col].map(val2idx).astype(int)
    return vals


def factor_dt(df, k, unit, astype=int):
    v = df[k]
    start = v.min()
    seconds = (v - start).apply(lambda td: td.total_seconds())
    scale = { 's': 1, 'm': 60, 'h': 60*60, }[unit]
    start = start.timestamp() / scale
    scaled = seconds / scale
    if astype:
        start = astype(start)
        scaled = scaled.astype(astype)
    df[k] = scaled
    return dict(start=start, unit=unit)


def reduce_df(df, cols=None, path=None):
    if not cols:
        cols = { col: True for col in df.columns }
    renames = {}
    keep_cols = []
    new_cols = []
    dict_cols = []
    dt_col_units = {}
    for col, setting in cols.items():
        if isinstance(setting, str):
            renames[col] = setting
            dict_cols.append(setting)
            new_cols.append(setting)
        elif setting is False:
            keep_cols.append(col)
            new_cols.append(col)
        elif setting is True:
            dict_cols.append(col)
            new_cols.append(col)
        elif isinstance(setting, dict):
            keys = list(setting.keys())
            if keys != [ 'dt_unit', ]:
                raise ValueError(f"Unrecognized setting for column {col}: {setting}")
            unit = setting['dt_unit']
            new_cols.append(col)
            dt_col_units[col] = unit
        else:
            raise ValueError(f"Unrecognized setting for column {col}: {setting}")

    df = df.rename(columns=renames)
    df = df[new_cols]

    dicts = {}
    for dt_col, unit in dt_col_units.items():
        dicts[dt_col] = factor_dt(df, dt_col, unit=unit)

    for col in dict_cols:
        dicts[col] = factor_col(df, col)

    cols = df.columns.tolist()
    rows = list(map(list, df.itertuples(index=False)))
    obj = dict(
        cols=cols,
        rows=rows,
        dicts=dicts,
    )
    if path:
        with open(path, 'w') as f:
            simplejson.dump(obj, f, ignore_nan=True)
            err(f"Wrote {path}")
    return df, obj
