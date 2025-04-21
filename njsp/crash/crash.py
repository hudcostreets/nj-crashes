from dataclasses import dataclass
from functools import cached_property
from re import fullmatch

from pandas import read_parquet, Series, Timestamp, isna

from nj_crashes.utils import SITE
from nj_crashes.utils.git import git_fmt
from nj_crashes.utils.github import REPO
from nj_crashes.utils.log import err
from njdot import normalize_name, cc2mc2mn
from njdot.cc2mc2mn import County
from njsp.crash.utils import Fmt, mk_dt_str, DEFAULT_FMT
from njsp.crashes import Crashes
from njsp.paths import MC_PQT


VICTIM_TYPES = {
    'D': 'driver',
    'P': 'passenger',
    'T': 'pedestrian',
    'B': 'cyclist',
}


@dataclass
class Crash:
    accid: int
    dt: Timestamp
    CCODE: str
    MCODE: str
    CNAME: str
    MNAME: str
    FATAL_D: int
    FATAL_P: int
    FATAL_T: int
    FATAL_B: int
    INJURIES: int | None
    LOCATION: str | None
    HIGHWAY: str | None

    @staticmethod
    def load(s: Series):
        return Crash(**{ **s, 'accid': int(s.name), })

    def __contains__(self, k: str):
        return hasattr(self, k)

    def __getitem__(self, k: str):
        return getattr(self, k)

    @property
    def DATE(self) -> str:
        """Return date as a string, in `%m/%d/%Y` format used in FAUQStats XMLs."""
        return self.dt.strftime("%m/%d/%Y")

    @property
    def TIME(self) -> str:
        """Return time as a 4-digit string, as it appears in FAUQStats XMLs."""
        return self.dt.strftime("%H%M")

    @property
    def cc(self) -> int:
        return int(self.CCODE)

    @cached_property
    def mc(r) -> int:
        if not fullmatch(r'\d{4}', r.MCODE):
            raise ValueError(f"Invalid MCODE {r.MCODE}")
        if r.MCODE[:2] != r.CCODE:
            raise ValueError(f"Invalid MCODE {r.MCODE} for CCODE {r.CCODE}")
        mc = int(r.MCODE[2:])
        sp2gin = read_parquet(MC_PQT)
        mc_gin = sp2gin[sp2gin.cc == r.cc].set_index('mc_sp').mc_gin.to_dict()[mc]
        if mc != mc_gin:
            err(f"cc {r.cc}: re-mapping mc {mc} to {mc_gin}")
            mc = mc_gin
        return mc

    @property
    def county(self) -> County:
        return cc2mc2mn[self.cc]

    @property
    def cn(self) -> str:
        return self.county.cn

    @property
    def mn(self) -> str:
        return self.county.mc2mn[self.mc]

    @cached_property
    def c_url(self) -> str:
        cs = normalize_name(self.cn)
        return f'{SITE}/c/{cs}'

    @property
    def m_url(self) -> str:
        ms = normalize_name(self.mn)
        return f'{self.c_url}/{ms}'

    @cached_property
    def urls(r) -> tuple[str, str]:
        return r.c_url, r.m_url

    def xml_url(self, ref: str | None = None):
        if not ref:
            ref = git_fmt(fmt='%H')
        if not fullmatch(r'[\da-f]+', ref):
            ref = git_fmt(ref, fmt='%H')
        accid_map = Crashes(ref=ref).accid_map
        rng = accid_map[str(self.accid)]
        (start_line, _), (end_line, _) = rng['start'], rng['end']
        path = rng['path']
        return f'https://github.com/{REPO}/blob/{ref}/{path}#L{start_line}-L{end_line}'

    @property
    def victim_str(self):
        victim_pcs = []
        for suffix, name in VICTIM_TYPES.items():
            num = self[f'FATAL_{suffix}']
            if not isna(num) and num > 0:
                num = int(num)
                noun = name if num == 1 else f'{name}s'
                victim_pcs.append(f'{num} {noun}')

        return ', '.join(victim_pcs)

    @property
    def injuries_str(self):
        injuries = self.INJURIES
        if isna(injuries) or not injuries:
            return ""
        else:
            return f", {int(injuries)} injuries"

    def slack_str(
        r,
        fmt: Fmt = DEFAULT_FMT,
        github_url: str | None = None,
    ) -> str:
        victim_str = r.victim_str
        dt_str = mk_dt_str(r['dt'], fmt)
        if isna(r.LOCATION):
            location = 'unknown location'
        else:
            location = r.LOCATION.replace('&', '&amp;')

        def link(uri: str, text: str) -> str:
            return f'<{uri}|{text}>'

        if github_url:
            gh_link = link(github_url, str(r.accid))
        else:
            gh_link = f'{r.accid}'

        c_url, m_url = r.urls
        c_link = link(uri=c_url, text=f'{r.CNAME} County')
        m_link = link(uri=m_url, text=r.MNAME)
        return f'*{dt_str} ({gh_link})*: {m_link} ({c_link}), {location}: {victim_str} deceased{r.injuries_str}'
