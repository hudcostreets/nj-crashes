import geopandas as gpd
import pandas as pd
from dataclasses import dataclass, asdict
from math import sqrt
from pandas import isna
from typing import Union, Tuple, Optional
from utz import cached_property, DF, sxs, err

from nj_crashes.geo import is_nj_ll
from nj_crashes.sri.mp05 import get_mp05_map
from njdot.load import load_type, INDEX_NAME, pk_renames

Year = Union[str, int]
Years = Union[Year, list[Year]]

ksi_renames = {
    'Total Killed': 'tk',
    'Total Injured': 'ti',
    'Pedestrians Killed': 'pk',
    'Pedestrians Injured': 'pi',
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
renames = {
    'Date': 'dt',
    **pk_renames,
    'County Name': 'cn',
    'Municipality Name': 'mn',
    'Police Department Code': 'pdc',
    'Police Department': 'pdn',
    'Police Station': 'station',
    'Latitude': 'olat',
    'Longitude': 'olon',
    'Crash Type Code': 'crash_type',
    'Severity': 'severity',
    **road_renames,
    **ksi_renames,
}


def map_year_df(df: pd.DataFrame) -> pd.DataFrame:
    df['cn'] = df.cn.apply(lambda cn: cn.title())
    df['mn'] = df.mn.apply(lambda mn: mn.title())
    df['pdn'] = df.pdn.apply(lambda pdn: pdn.title())
    df['olon'] = -df['olon']  # Longitudes all come in positive, but are actually supposed to be negative (NJ ⊂ [-75, -73])
    df['severity'] = df['severity'].apply(lambda s: s.lower())
    return df


def load(
    years: Years = None,
    county: str = None,
    read_pqt: Optional[bool] = None,
    write_pqt: bool = False,
    cols: Optional[list[str]] = None,
):
    return load_type(
        tpe='Accidents',
        years=years,
        county=county,
        renames=renames,
        cols=cols,
        read_pqt=read_pqt,
        write_pqt=write_pqt,
        map_year_df=map_year_df,
    )


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
