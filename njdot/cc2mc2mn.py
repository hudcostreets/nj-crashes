import json

from njdot.paths import CC2MC2MN


def load():
    with open(CC2MC2MN, 'r') as f:
        cc2mc2mn = json.load(f)
    return {
        int(cc): {
            'cn': v['cn'],
            'mc2mn': {
                int(mc): mn
                for mc, mn in v['mc2mn'].items()
            }
        }
        for cc, v in cc2mc2mn.items()
    }


cc2mc2mn = load()
