import pandas as pd
from utz import sxs

from njsp.paths import MC_PQT

# NJSP fatal-crash type columns → friendly names.
TYPE_RENAMES = {
    'FATAL_D': 'driver',
    'FATAL_P': 'passenger',
    'FATAL_T': 'pedestrian',
    'FATAL_B': 'cyclist',
}
TYPES = list(TYPE_RENAMES.values())


def to_ytc(df):
    """Year-type-county aggregation of NJSP fatal crashes."""
    df = df.rename(columns={'CNAME': 'county', **TYPE_RENAMES})
    yt = sxs(
        df.dt.dt.year.rename('year'),
        df[['county', *TYPES]],
    )
    grouped = yt.groupby(['year', 'county'])
    return sxs(
        grouped[TYPES].sum().astype(int),
        grouped.size().rename('crashes'),
    )


def to_ytmc(df):
    """Year-type-municipality aggregation of NJSP fatal crashes, keyed by
    canonical NJGIN `(cc, mc)` codes.

    NJSP's own municipality codes (`MCODE` = 2-digit county + 2-digit
    muni) differ from NJGIN's. `muni_codes.parquet` (built by
    `njdot/harmonize_muni_codes.py`) maps `(cc, mc_sp) → mc_gin`, and the
    frontend's `cc2mc2mn.json` is keyed by `mc_gin` — so keying the
    output by `mc_gin` lets the frontend join on `(cc, mc)` directly."""
    df = df.rename(columns=TYPE_RENAMES)
    sp2gin = pd.read_parquet(MC_PQT)[['cc', 'mc_sp', 'mc_gin']]
    yt = sxs(
        df.dt.dt.year.rename('year'),
        df.CCODE.astype(int).rename('cc'),
        df.MCODE.str[2:].astype('Int64').rename('mc_sp'),
        df.CNAME.rename('county'),
        df.MNAME.rename('municipality'),
        df[TYPES],
    )
    yt = (
        yt
        .merge(sp2gin, on=['cc', 'mc_sp'], how='left', validate='many_to_one')
        .rename(columns={'mc_gin': 'mc'})
    )
    grouped = yt.groupby(['year', 'cc', 'mc', 'county', 'municipality'])
    return sxs(
        grouped[TYPES].sum().astype(int),
        grouped.size().rename('crashes'),
    )
