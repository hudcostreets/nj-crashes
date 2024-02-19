from typing import Literal

from njdot.opts import parse_opt

TYPE_TO_FIELDS = {
    'Accidents': 'Crash',
    'Drivers': 'Driver',
    'Occupants': 'Occupant',
    'Pedestrians': 'Pedestrian',
    'Vehicles': 'Vehicle',
}
TYPE_TO_TBL = {
    'Accidents': 'crashes',
    'Drivers': 'drivers',
    'Occupants': 'occupants',
    'Pedestrians': 'pedestrians',
    'Vehicles': 'vehicles',
}
CH_TO_TBL = { v[0]: v for v in TYPE_TO_TBL.values() }
TBL_TO_TYPE = { v: k for k, v in TYPE_TO_TBL.items() }
TYPES = list(TYPE_TO_FIELDS.keys())
Type = Literal[ 'Accidents', 'Drivers', 'Occupants', 'Pedestrians', 'Vehicles', ]


def parse_type(type_str) -> Type:
    matched_types = [
        typ
        for typ in TYPE_TO_FIELDS
        if typ.lower().startswith(type_str.lower())
    ]
    if len(matched_types) != 1:
        raise ValueError(f"Table type {type_str} matched {len(matched_types)} types: {matched_types}")
    return matched_types[0]


def parse_types(types_str) -> list[Type]:
    if not types_str:
        return TYPES
    return [ parse_type(type_str) for type_str in types_str.split(',') ]


types_opt = parse_opt(
    '-t', '--types',
    parse=parse_types, kw='types',
    help=f"Comma-separated list of record types ({', '.join(TYPES)}); unique, case-insensitive prefixes also supported",
)
