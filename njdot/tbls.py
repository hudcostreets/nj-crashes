from typing import Literal

from njdot.opts import parse_opt

Type = Literal[ 'Accidents', 'Drivers', 'Occupants', 'Pedestrians', 'Vehicles', ]
Tbl = Literal[ 'crashes', 'drivers', 'occupants', 'pedestrians', 'vehicles', ]
TYPE_TO_FIELDS = {
    'Accidents': 'Crash',
    'Drivers': 'Driver',
    'Occupants': 'Occupant',
    'Pedestrians': 'Pedestrian',
    'Vehicles': 'Vehicle',
}
TYPE_TO_TBL: dict[Type, Tbl] = {
    'Accidents': 'crashes',
    'Drivers': 'drivers',
    'Occupants': 'occupants',
    'Pedestrians': 'pedestrians',
    'Vehicles': 'vehicles',
}
CH_TO_TBL = { v[0]: v for v in TYPE_TO_TBL.values() }
TBL_TO_TYPE = { v: k for k, v in TYPE_TO_TBL.items() }
TYPES: list[Type] = list(TYPE_TO_TBL.keys())
TBLS: list[Tbl] = list(TYPE_TO_TBL.values())


def parse_type(type_str) -> Type:
    matched_types = [
        typ
        for typ in TYPE_TO_FIELDS
        if typ.lower().startswith(type_str.lower())
    ]
    if len(matched_types) != 1:
        raise ValueError(f"Type str {type_str} matched {len(matched_types)} types: {matched_types}")
    return matched_types[0]


def parse_types(types_str) -> list[Type]:
    if not types_str:
        return TYPES
    return [
        parse_type(type_str)
        for type_str in types_str.split(',')
    ]


types_opt = parse_opt(
    '-t', '--types',
    parse=parse_types, kw='types',
    help=f"Comma-separated list of record types ({', '.join(TYPES)}); unique, case-insensitive prefixes also supported",
)


def parse_tbl(tbl_str) -> Tbl:
    matched_tbls = [
        tbl
        for tbl in TBL_TO_TYPE
        if tbl.lower().startswith(tbl_str.lower())
    ]
    if len(matched_tbls) != 1:
        raise ValueError(f"Table str {tbl_str} matched {len(matched_tbls)} tables: {matched_tbls}")
    return matched_tbls[0]


def parse_tbls(tbls_str) -> list[Tbl]:
    if not tbls_str:
        return TBLS
    return [
        parse_tbl(tbl_str)
        for tbl_str in tbls_str.split(',')
    ]


tbls_opt = parse_opt(
    '-t', '--tables',
    parse=parse_tbls, kw='tbls',
    help=f"Comma-separated list of record tables ({', '.join(TBLS)}); unique, case-insensitive prefixes also supported",
)
