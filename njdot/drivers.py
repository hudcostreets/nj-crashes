from typing import Optional

from njdot.load import Years, load_type

renames = {
    'Year': 'year',
    'Vehicle Number': 'vn',
}

def load(
        years: Years = None,
        county: str = None,
        read_pqt: Optional[bool] = None,
        write_pqt: bool = False,
        cols: Optional[list[str]] = None,
):
    df = load_type(
        'Drivers',
        years=years,
        county=county,
        renames=renames,
        # astype=astype,
        cols=cols,
        # map_year_df=map_year_df,
        # map_df=map_df,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
    )
    return df
