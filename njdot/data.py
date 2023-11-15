from os import path
from os.path import dirname

import dask.dataframe as dd
import pandas as pd
from typing import Literal, Optional

from dataclasses import dataclass, field, asdict

START_YEAR, END_YEAR = 2001, 2022
COUNTIES = [
    'Atlantic',
    'Bergen',
    'Burlington',
    'Camden',
    'CapeMay',
    'Cumberland',
    'Essex',
    'Gloucester',
    'Hudson',
    'Hunterdon',
    'Mercer',
    'Middlesex',
    'Monmouth',
    'Morris',
    'Ocean',
    'Passaic',
    'Salem',
    'Somerset',
    'Sussex',
    'Union',
    'Warren',
]
REGIONS = ['NewJersey'] + COUNTIES
YEARS: list[str] = list(map(str, range(START_YEAR, END_YEAR)))
TYPE_TO_TABLE = {
    'Accidents': 'Crash',
    'Drivers': 'Driver',
    'Occupants': 'Occupant',
    'Pedestrians': 'Pedestrian',
    'Vehicles': 'Vehicle',
}
TYPES = list(TYPE_TO_TABLE.keys())
Type = Literal[ 'Accidents', 'Drivers', 'Occupants', 'Pedestrians', 'Vehicles', ]

YPK = ['County Code', 'Municipality Code', 'Department Case Number']
PK = ['Year'] + YPK

DATA_DIR = path.join(dirname(__file__), 'data')
FIELDS_DIR = f'{DATA_DIR}/fields'


def hist(df, code, desc=None):
    df = df.value_counts()
    if desc is None:
        df = df.sort_index()
    elif desc is False:
        pass
    elif desc is True:
        df = df.sort_values(ascending=False)
    else:
        raise
    if code:
        df.index = df.index.to_series().apply(lambda v: code[v])
    return df


@dataclass
class Data:
    years: list[str] = field(default_factory=lambda: [*YEARS])
    types: list[Type] = field(default_factory=lambda: [*TYPES])
    columns: Optional[list[str]] = None

    @property
    def ddf(self) -> dd.DataFrame:
        types = self.types
        if len( types) != 1:
            raise RuntimeError(f"Select a type ({ types}) before creating ddf")
        [tpe] = types
        region = 'NewJersey'
        return dd.concat([
            dd.read_parquet(f'{DATA_DIR}/{year}/{region}{year}{tpe}.pqt', columns=self.columns).assign(Year=year)
            for year in self.years
        ])

    def df(self, cols=None) -> pd.DataFrame:
        if cols is None:
            return self.ddf.compute().set_index(PK)
        else:
            if isinstance(cols, str):
                return self.cols(YPK + [cols]).df()[cols]
            else:
                return self.cols(YPK + cols).df()

    def series(self, col):
        return self.cols(YPK + [col]).df()[col]

    def __getitem__(self, k):
        if k in self.types:
            return self.copy(types=[k])
        elif k in self.years:
            return self.copy(years=[k])
        elif isinstance(k, int) and str(k) in self.years:
            return self.copy(years=[str(k)])
        elif isinstance(k, list):
            if all([ e in self.types for e in k ]):
                return self.copy(types=k)
            elif all([ e in self.years for e in k ]):
                return self.copy(years=k)
            elif all([ isinstance(e, int) and str(e) in self.years for e in k ]):
                return self.copy(years=list(map(str, k)))
        return asdict(self)[k]

    def copy(self, **kwargs):
        return Data(
            **{ k: v for k, v in asdict(self).items() if k not in kwargs },
            **kwargs,
        )

    def cols(self, cols):
        return self.copy(columns=cols)
