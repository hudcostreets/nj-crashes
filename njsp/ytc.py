from utz import sxs

RENAMES = {
    'CNAME': 'county',
    'FATAL_D': 'driver',
    'FATAL_P': 'passenger',
    'FATAL_T': 'pedestrian',
    'FATAL_B': 'cyclist',
}


def to_ytc(df):
    df = df.rename(columns=RENAMES)
    ytc = sxs(
        df.dt.dt.year.rename('year'),
        df[RENAMES.values()],
    )
    grouped = ytc.groupby(['year', 'county'])
    return sxs(
        grouped.sum().astype(int),
        grouped.size().rename('crashes'),
    )
