from dataclasses import dataclass

from nj_crashes.sri.sri import SRI


@dataclass
class SriMap:
    sris: dict[str, SRI]

    @classmethod
    def make_mps_arr(cls, s) -> dict[float, [ float, float ]]:
        return dict(s.apply(lambda r: [ r.MP, [ r.LON, r.LAT ]], axis=1).tolist())

    @classmethod
    def get_sri_mps_map(cls, sri_mps) -> dict[str, dict[float, [ float, float ]]]:
        sri_mps_map = (
            sri_mps
            .groupby('SRI')
            .apply(cls.make_mps_arr)
        )
        return sri_mps_map.to_dict()

    def __getitem__(self, sri):
        return self.sris[sri]

    @classmethod
    def load(cls, sri_mps) -> dict[str, SRI]:
        sri_mps_map = cls.get_sri_mps_map(sri_mps)
        return {
            sri: SRI(sri, mp_lls)
            for sri, mp_lls in sri_mps_map.items()
        }
