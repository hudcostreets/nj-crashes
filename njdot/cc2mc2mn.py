import json
from dataclasses import dataclass
from typing import Dict

from njdot import paths


@dataclass
class County:
    cn: str
    mc2mn: Dict[int, str]

CC2MC2MN = Dict[int, County]

def load() -> CC2MC2MN:
    with open(paths.CC2MC2MN, 'r') as f:
        cc2mc2mn = json.load(f)
    return {
        int(cc): County(
            cn=v['cn'],
            mc2mn={
                int(mc): mn
                for mc, mn in v['mc2mn'].items()
            }
        )
        for cc, v in cc2mc2mn.items()
    }


def normalize_name(name: str):
    return name.lower().replace(' ', '-')

def denormalize_name(slug: str):
    return slug.replace('-', ' ').title()


cc2mc2mn = load()
