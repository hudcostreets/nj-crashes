from os.path import exists

import dask.dataframe as dd
import pandas as pd
from dataclasses import dataclass, field, asdict
from typing import Optional

from njdot.paths import DOT_DATA, DOT_DATA_S3
from njdot.tbls import Type, TYPES

START_YEAR, END_YEAR = 2001, 2024
YEARS: list[int] = list(range(START_YEAR, END_YEAR))

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

cc2cn = {
    cc: 'Cape May' if cn == 'CapeMay' else cn
    for cc, cn in enumerate(COUNTIES, 1)
}
cn2cc = { cn: cc for cc, cn in cc2cn.items() }

YPK = ['County Code', 'Municipality Code', 'Department Case Number']
PK = ['Year'] + YPK

FIELDS_DIR = f'{DOT_DATA}/fields'


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
    years: list[int] = field(default_factory=lambda: [*YEARS])
    types: list[Type] = field(default_factory=lambda: [*TYPES])
    columns: Optional[list[str]] = None

    @staticmethod
    def pqt_url(year: int, tpe: Type, region: str = 'NewJersey'):
        name = f'{region}{year}{tpe}.pqt'
        local_path = f'{DOT_DATA}/{year}/{name}'
        if exists(local_path):
            return local_path
        else:
            return f'{DOT_DATA_S3}/{year}/{name}'

    @property
    def ddf(self) -> dd.DataFrame:
        types = self.types
        if len(types) != 1:
            raise RuntimeError(f"Select a type ({ types}) before creating ddf")
        [tpe] = types
        return dd.concat([
            dd.read_parquet(self.pqt_url(year, tpe), columns=self.columns).assign(Year=year)
            for year in self.years
        ])

    def df(self, cols: Optional[list[str]] = None, index: bool = True) -> pd.DataFrame:
        if cols is None:
            df = self.ddf.compute()
            if index:
                df = df.set_index(PK)
            return df
        else:
            if isinstance(cols, str):
                return self.cols((YPK + [cols]) if index else [cols]).df(index=index)[cols]
            else:
                return self.cols((YPK + cols) if index else cols).df(index=index)

    def series(self, col):
        return self.cols(YPK + [col]).df()[col]

    def __getitem__(self, k):
        if k in self.types:
            return self.copy(types=[k])
        elif k in self.years:
            return self.copy(years=[k])
        elif isinstance(k, str) and int(k) in self.years:
            return self.copy(years=[int(k)])
        elif isinstance(k, list):
            if all([ e in self.types for e in k ]):
                return self.copy(types=k)
            elif all([ e in self.years for e in k ]):
                return self.copy(years=k)
            elif all([ isinstance(e, str) and int(e) in self.years for e in k ]):
                return self.copy(years=list(map(int, k)))
        return asdict(self)[k]

    def copy(self, **kwargs):
        return Data(
            **{ k: v for k, v in asdict(self).items() if k not in kwargs },
            **kwargs,
        )

    def cols(self, cols):
        return self.copy(columns=cols)
