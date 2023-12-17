from json import JSONDecodeError
from os import path

import json
import math
import pandas as pd
from dataclasses import dataclass
from typing import Optional
from utz import cached_property, err

from nj_crashes.paths import SRI_DIR
# from nj_crashes.sri.mp05 import SRI_DB_URL


def get_sri_path(sri: str) -> str:
    return path.join(SRI_DIR, sri)


# def load_sri_mps():
#     return pd.read_sql_table('sri_mp', SRI_DB_URL)


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
    _mp2ll: dict[float, LL] = None

    @cached_property
    def mp2ll(self) -> dict[float, LL]:
        if self._mp2ll is not None:
            return self._mp2ll
        else:
            features_df = self.features_df
            return dict(features_df[[ 'mp', 'lon', 'lat']].apply(lambda r: [ r.mp, [ r.lon, r.lat ]], axis=1).tolist())

    @cached_property
    def ranges(self):
        mps = list(self.mp2ll.keys())
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
                [ lon, lat ] = self.mp2ll[floor]
            else:
                [ lon0, lat0 ] = self.mp2ll[floor]
                if ceil not in self.mp2ll:
                    raise ValueError(f"SRI {self.sri} MP {mp}, range [{start},{end}], floor {floor}, ceil {ceil} not found")
                [ lon1, lat1 ] = self.mp2ll[ceil]
                lon = lon0 + (lon1 - lon0) * (mp - floor) / (ceil - floor)
                lat = lat0 + (lat1 - lat0) * (mp - floor) / (ceil - floor)
            return LL(lon, lat)
        return None

    @property
    def path(self):
        return get_sri_path(self.sri)

    @property
    def responses(self):
        try:
            with open(self.path, 'r') as f:
                return json.load(f)
        except JSONDecodeError:
            err(f"SRI {self.sri}: JSONDecodeError")
            return []

    @property
    def features(self):
        features = []
        responses = self.responses
        if isinstance(responses, dict):
            responses = [ responses ]
        for response_idx, response in enumerate(responses):
            if not isinstance(response, dict):
                err(f"SRI {self.sri}: response {response_idx} is not a dict")
                continue
            if 'features' not in response:
                err(f"SRI {self.sri}: response {response_idx} has no features")
                continue
            for feature_idx, feature in enumerate(response['features']):
                obj = {}
                if 'attributes' in feature:
                    obj = dict(**feature['attributes'])
                else:
                    pass
                    # if response_idx + 1 == len(responses) and feature_idx + 1 == len(response['features']):
                    #     err(f"SRI {self.sri}: last feature ({response_idx}, {feature_idx}) has no attributes")
                    # else:
                    #     err(f"SRI {self.sri}: response {response_idx} feature {feature_idx} has no attributes")
                if 'geometry' in feature:
                    obj = dict(**obj, **feature['geometry'])
                else:
                    pass
                    # if response_idx + 1 == len(responses) and feature_idx + 1 == len(response['features']):
                    #     err(f"SRI {self.sri}: last feature ({response_idx}, {feature_idx}) has no geometry")
                    # else:
                    #     err(f"SRI {self.sri}: response {response_idx} feature {feature_idx} has no geometry")
                features.append(obj)
        return features

    @property
    def features_df(self):
        return pd.DataFrame(self.features)

    @cached_property
    def sld_name(self):
        sld_names = self.features_df.SLD_NAME.value_counts()
        if len(sld_names) != 1:
            raise ValueError(f"SRI {self.sri}: expected 1 SLD_NAME, found {len(sld_names)}: {sld_names}")
        return sld_names.index[0]

    @cached_property
    def second_name(self):
        second_names = self.features_df.Second_Name.value_counts()
        if len(second_names) > 1:
            err(f"SRI {self.sri}: {len(second_names)} Second_Names:\n{second_names}")
        elif second_names.empty:
            err(f"SRI {self.sri}: {len(second_names)} Second_Names found")
        return second_names.index[0]

    def __contains__(self, mp):
        for start, end in self.ranges:
            if start <= mp <= end:
                return True
        return False
