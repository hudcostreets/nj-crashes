import pandas as pd

import geopandas as gpd
from nj_crashes.sri.sri_map import SriMap


def make_mp10():
    mp10s = gpd.read_file("NJ_Milepost10ths_shp/TRAN_NJ_MP_TENTH_2021_shp.shp")
    sri_mp_all = mp10s[['SRI', 'MP', 'LATITUDE', 'LONGTUDE']]
    mp10 = (
        sri_mp_all
        .drop_duplicates()
        .rename(columns={'LATITUDE': 'LAT', 'LONGTUDE': 'LON'})
        .sort_values(['SRI', 'MP'])
        .dropna()
    )
    mp10.to_parquet('mp10.parquet')


_mp10 = None


def get_mp10():
    global _mp10
    if _mp10 is None:
        _mp10 = pd.read_parquet('mp10.parquet')
    return _mp10


def get_mp10_map():
    mp10 = get_mp10()
    return SriMap.load(mp10)
