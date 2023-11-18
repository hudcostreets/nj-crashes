from typing import Optional

import math

from dataclasses import dataclass

import pandas as pd
from utz import cached_property


def load_sri_mps():
    return pd.read_sql_table('sri_mp', 'sqlite:///../nj_sri_mp.db')


def make_mps_arr(s) -> dict[float, [ float, float ]]:
    return dict(s.apply(lambda r: [ r.MP, [ r.LON, r.LAT ]], axis=1).tolist())


def get_sri_mps_map() -> dict[str, dict[float, [ float, float ]]]:
    sri_mps = load_sri_mps()
    sri_mps_map = (
        sri_mps
        .groupby('SRI')
        .apply(make_mps_arr)
    )
    return sri_mps_map.to_dict()


@dataclass
class LL:
    lon: float
    lat: float


@dataclass
class MP:
    mp: float
    ll: LL


@dataclass
class MPLLs:
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
                end = cur_mp
                ranges.append([ start, end ])
                start = cur_mp
            prv_mp = cur_mp
            i += 1
        return ranges

    def __getitem__(self, mp):
        ll = self.ll(mp)
        if ll is None:
            raise ValueError(f"MP {mp} not in SRI {self.sri}")
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
            [ lon0, lat0 ] = self.mp_lls[floor]
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


@dataclass
class SRI:
    sri: str
    mp_lls: MPLLs


def get_sris() -> dict[str, MPLLs]:
    sri_mps_map = get_sri_mps_map()
    return {
        sri: MPLLs(mp_lls)
        for sri, mp_lls in sri_mps_map.items()
    }
