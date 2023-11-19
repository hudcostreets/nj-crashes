from typing import Optional

import math

from dataclasses import dataclass

import pandas as pd
from utz import cached_property


def load_sri_mps():
    return pd.read_sql_table('sri_mp', 'sqlite:///../nj_sri_mp.db')


@dataclass
class LL:
    lon: float
    lat: float


@dataclass
class MP:
    mp: float
    ll: LL


@dataclass
class SRI:
    sri: str
    mp_lls: dict[float, LL]

    @cached_property
    def ranges(self):
        mps = list(self.mp_lls.keys())
        n = len(mps)
        start = mps[0]
        prv_mp = mps[0]
        i = 1
        ranges = []
        while i < n:
            cur_mp = mps[i]
            expected = round(prv_mp + 0.05, 2)
            if expected != cur_mp or i + 1 == n:
                ranges.append([ start, prv_mp ])
                start = cur_mp
            prv_mp = cur_mp
            i += 1
        return ranges

    def __getitem__(self, mp):
        ll = self.ll(mp)
        if ll is None:
            raise ValueError(f"MP {mp} not found in SRI {self.sri}")
        return ll

    def get(self, mp, default=None):
        ll = self.ll(mp)
        if ll is None:
            return default
        return ll

    def ll(self, mp) -> Optional[LL]:
        for start, end in self.ranges:
            if not (start <= mp <= end):
                continue
            floor = math.floor(mp * 20) / 20
            ceil = math.ceil(mp * 20) / 20
            if floor == ceil:
                [ lon, lat ] = self.mp_lls[floor]
            else:
                [ lon0, lat0 ] = self.mp_lls[floor]
                if ceil not in self.mp_lls:
                    raise ValueError(f"SRI {self.sri} MP {mp}, range [{start},{end}], floor {floor}, ceil {ceil} not found")
                [ lon1, lat1 ] = self.mp_lls[ceil]
                lon = lon0 + (lon1 - lon0) * (mp - floor) / (ceil - floor)
                lat = lat0 + (lat1 - lat0) * (mp - floor) / (ceil - floor)
            return LL(lon, lat)
        return None

    def __contains__(self, mp):
        for start, end in self.ranges:
            if start <= mp <= end:
                return True
        return False
