from os.path import dirname, join
from types import SimpleNamespace

import duckdb
import numpy as np
import pandas as pd
import pytest
import shapely

from njdot.cc2mc2mn import cc2mc2mn
from njdot.cli.roads import build_geom
from njdot.loc_recovery import (
    Snapper, base_key, clean_road, cluster_point, entity_at, learn_names, loc_key, meet_points, ng_name_index,
    nodir_key, offset_along, offset_m, recover, resolve_keys, route_keys, route_sri, seg_entities, split_road,
)
from njdot.road_net import rn_features


def na(xs):
    return [None if x is None or pd.isna(x) else x for x in xs]


def test_clean_road_and_loc_key():
    s = pd.Series([
        '981 WESTSIDE AVE', 'W. SIDE AVENUE **', 'THIRTY-NINTH STREET', 'E 39 TH ST', 'WESTSIDE AVE PARKING LOT',
        '12A BERGEN AVE', '1ST AVE', '3 RD ST', '', None, 'MLK DRIVE', 'DOCTOR MARTIN LUTHER KING JUNIOR BOULEVARD',
        'TONNELLE AVE', 'JOHN F. KENNEDY BLVD', 'ELEVENTH ST', 'TICES LA', 'SOUTH TWENIETH STREET',
    ])
    c = clean_road(s)
    assert na(c) == [
        'WESTSIDE AVE', 'W SIDE AVENUE', 'THIRTY-NINTH STREET', 'E 39 TH ST', 'WESTSIDE AVE',
        'BERGEN AVE', '1ST AVE', '3 RD ST', None, None, 'MLK DRIVE', 'DOCTOR MARTIN LUTHER KING JUNIOR BOULEVARD',
        'TONNELLE AVE', 'JOHN F KENNEDY BLVD', 'ELEVENTH ST', 'TICES LA', 'SOUTH TWENIETH STREET',
    ]
    k = loc_key(c)
    assert na(k) == [
        'WESTSIDEAVE', 'WESTSIDEAVE', '39THST', 'EAST39THST', 'WESTSIDEAVE',
        'BERGENAVE', '1STAVE', '3RDST', None, None, 'MARTINLUTHERKINGDR', 'MARTINLUTHERKINGBLVD',
        # Doubled letters squeezed ("TONNELE" == "TONNELLE"), digits not ("11TH" ≠ "1ST").
        'TONELEAVE', 'JFKENEDYBLVD', '11THST', 'TICESLN', 'SOUTH20THST',
    ]
    assert na(base_key(k[:3])) == ['WESTSIDE', 'WESTSIDE', '39TH']


def test_nodir_key():
    k = pd.Series(['SOUTH3RDST', '3RDST', 'WESTSIDEAVE', 'PARKAVEEAST', 'EAST39THST'], dtype='string')
    assert na(nodir_key(k)) == ['3RDST', '3RDST', 'WESTSIDEAVE', 'PARKAVE', '39THST']


def test_split_road():
    df = split_road(
        pd.Series(['DUNCAN AVE / W SIDE AVE', 'A ST & B ST', 'US 1 & 9', 'AVENUE AT PORT IMPERIAL', 'X ST']),
        pd.Series([None, 'C ST', None, None, 'Y ST']),
    )
    assert [na(r) for r in df.values.tolist()] == [
        ['DUNCAN AVE', 'W SIDE AVE'],  # the second part fills an empty cross street
        ['A ST', 'C ST'],  # … not a given one
        ['US 1 & 9', None],  # a route, not an intersection
        ['AVENUE AT PORT IMPERIAL', None],
        ['X ST', 'Y ST'],
    ]


ROUTES = pd.Series([
    'US 1 & 9', 'RT 1&9', 'HUDSON COUNTY 617', 'ROUTE 501', 'RT 440', 'US 1 TRUCK', 'NJ 139 UPPER', 'I-78', 'CR 601',
    'WEST SIDE AVE', None,
])


def test_route_sri():
    assert na(route_sri(ROUTES, pd.Series([9] * len(ROUTES)))) == [
        '00000001__', '00000001__', '09000617__', '00000501__', '00000440__', '00000001T_', '00000139U_', '00000078__',
        '09000601__', None, None,
    ]


def test_route_keys():
    assert route_keys(ROUTES).tolist() == [
        ('R:US1',), ('R:US1', 'R:NJ1', 'R:I1'), ('R:CR617',), ('R:US501', 'R:NJ501', 'R:I501', 'R:CR501'),
        ('R:US440', 'R:NJ440', 'R:I440'), ('R:US1',), ('R:NJ139',), ('R:I78',), ('R:CR601',), None, None,
    ]


def test_offset_m():
    m = offset_m(pd.Series([100, None, 2, 50000, 30]), pd.Series(['FE', 'AT', 'MI', 'FE', 'AT']))
    # 50000 ft is clamped to a mile; "AT" is 0 whatever the distance.
    assert m.round(3).tolist() == [30.48, 0.0, 3218.688, 1609.344, 0.0]


def test_resolve_keys():
    idx = pd.DataFrame({
        'seg': [0, 1, 2, 3, 4, 5],
        'cc': [9] * 6,
        'mc': [6] * 6,
        'key': ['WESTSIDEAVE', 'NORTH3RDST', 'SOUTH3RDST', 'AUDUBONAVE', 'PARKAVE', 'PARKST'],
    })
    idx['base'] = base_key(idx['key'].astype('string'))
    q = pd.DataFrame({
        'cc': [9, 9, 9, 9, 9, 9, 9],
        'mc': [6, 6, 6, 6, 6, 6, 1],
        'key': ['WESTSIDEAVE', 'WESTSIDE', '3RDST', 'AUDIBONAVE', 'PARK', 'ELMST', 'WESTSIDEAVE'],
    })
    r = resolve_keys(q, idx)
    assert list(zip(r['ng_keys'], na(r['how']))) == [
        (('WESTSIDEAVE',), 'exact'),
        (('WESTSIDEAVE',), 'base'),  # the only "WESTSIDE…" in the muni
        (('NORTH3RDST', 'SOUTH3RDST'), 'nodir'),  # both kept, for the cross street to pick
        (('AUDUBONAVE',), 'fuzzy'),
        (None, None),  # "PARK" → Park Ave or Park St: ambiguous
        (None, None),
        (None, None),  # another muni
    ]


def lines(*coords):
    return np.array([shapely.linestrings(c) for c in coords], dtype=object)


def test_meet_cluster_offset():
    # A road along y=0 (x 0…1000 m), a cross street along x=400, another far away along x=900 (no meet).
    road = lines([(0, 0), (500, 0)], [(500, 0), (1000, 0)])
    cross = lines([(400, -200), (400, 0)], [(400, 0), (400, 200)])
    far = lines([(900, 50), (900, 300)])
    pts = meet_points(road, cross)
    assert sorted(map(tuple, pts.round(3).tolist())) == [(400.0, 0.0), (400.0, 0.0)]
    assert meet_points(road, far).shape == (0, 2)
    p = cluster_point(pts)
    assert p.round(3).tolist() == [400.0, 0.0]
    # Two meets 600 m apart (a crescent, or two same-named streets): ambiguous.
    assert cluster_point(np.array([[0.0, 0.0], [600.0, 0.0]])) is None
    assert offset_along(road, p, 100, 'E').round(3).tolist() == [500.0, 0.0]
    assert offset_along(road, p, 100, 'W').round(3).tolist() == [300.0, 0.0]
    # The road runs east-west: "N of the cross street" has nowhere to go.
    assert offset_along(road, p, 100, 'N') is None
    # No direction: at the intersection if near enough, else unplaceable.
    assert offset_along(road, p, 50, '').round(3).tolist() == [400.0, 0.0]
    assert offset_along(road, p, 100, '') is None


def test_entity_at():
    runs = pd.DataFrame({'entity': [1, 2, 3], 'sri': ['A', 'A', 'B'], 'mp_lo': [0.0, 1.0, 0.0], 'mp_end': [1.0, 2.0, 0.5]})
    e = entity_at(pd.Series(['A', 'A', 'A', 'B', 'B', 'C', None]), pd.Series([0.5, 1.0, 2.5, 0.1, np.nan, 0.1, 0.1]), runs)
    assert na(e) == [1, 2, None, 3, None, None, None]


def test_learn_names():
    coded = pd.DataFrame({
        'cc': [9] * 9,
        'mc': [6] * 9,
        'road': ['COLUMBUS DR'] * 5 + ['PARK AVE'] * 3 + ['A ST / B ST'],
        'entity': [7, 7, 7, 7, 8, 1, 2, 1, 5],
    })
    assert learn_names(coded, min_n=3, min_share=0.8).values.tolist() == [[9, 6, 'COLUMBUSDR', 7, 5, 0.8]]


FIXTURES = join(dirname(__file__), 'data', 'roads')


@pytest.fixture(scope='module')
def real():
    """The `test_roads` real-data fixtures (Jersey City's West Side / Duncan Ave, JFK Blvd, …)."""
    rn = pd.read_parquet(join(FIXTURES, 'roadway_network.parquet'))
    cl = pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet'))
    al = pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet'))
    b = build_geom(rn, cl, al, duckdb.connect())
    seg_sris = pd.Series(pd.NA, index=np.arange(len(b['seg'])), dtype='string')
    seg_sris.loc[b['iv']['seg'].to_numpy()] = b['iv']['sri'].to_numpy()
    return SimpleNamespace(
        runs=b['runs'], seg=b['seg'], idx=ng_name_index(cl, al, cc2mc2mn), seg_ent=seg_entities(b['seg'], b['iv'], b['runs']),
        seg_sris=seg_sris, snapper=Snapper(rn_features(rn)), names=b['runs'].groupby('entity')['name'].first(),
    )


def crash(road, cross=None, sri=None, mp=None, dist=None, unit=None, d=None, road_system=7):
    return {
        'cc': 9, 'mc': 6, 'sri': sri, 'mp': mp, 'road': road, 'cross_street': cross, 'cross_street_distance': dist,
        'Unit Of Measurement': unit, 'Direction From Cross Street': d, 'road_system': road_system,
        'ilat': None, 'ilon': None, 'olat': None, 'olon': None,
    }


def test_recover_real(real):
    cs = pd.DataFrame([
        crash('WESTSIDE AVE', 'DUNCAN AVE', unit='AT'),
        # West Side Ave runs north into Duncan Ave: 500 ft S of it is on West Side, N is nowhere.
        crash('W SIDE AVENUE', 'DUNCAN AVENUE', dist=500, unit='FE', d='S'),
        crash('W SIDE AVENUE', 'DUNCAN AVENUE', dist=500, unit='FE', d='N'),
        crash('DUNCAN AVE', 'WEST SIDE AVE', dist=300, unit='FE', d='W'),
        crash('981 WEST SIDE AVE **'),
        crash('WESTSIDE'),
        crash('HUDSON COUNTY 501', 'DUNCAN AVE'),
        # A coded crash keeps its SRI / MP; one without MP on a single-entity SRI gets the entity.
        crash('WEST SIDE AVE', sri='09061684__', mp=1.2),
        crash('WEST SIDE AVE', sri='09061575__'),
        # An SRI gone from the current network (Hudson's pre-2018 county-route SRIs): re-located.
        crash('WEST SIDE AVE', 'DUNCAN AVE', sri='09000617__', mp=1.0, dist=500, unit='FE', d='S'),
        crash('WEST SIDE AVE', 'DUNCAN AVE', road_system=9),  # private property
        crash('DUNCAN AVE / W SIDE AVE'),  # either may be the road
        crash('WEST SIDE AVE', 'BERGEN AVE'),  # never meet: a wrong name, so no name-only guess
        crash('MAIN ST'),
    ])
    out = recover(cs, real.seg, real.idx, real.seg_ent, real.seg_sris, real.snapper, real.runs)
    rows = [
        (s, None if pd.isna(sri) else sri, None if pd.isna(mp) else round(float(mp), 2), None if pd.isna(e) else real.names[e], None if pd.isna(h) else h)
        for s, sri, mp, e, h in zip(out['loc_source'], out['sri'], out['mp'], out['entity'], out['how'])
    ]
    assert rows == [
        ('intersection', '09061684__', 1.93, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.86, 'West Side Avenue', 'exact'),
        ('name_only', None, None, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.99, 'Duncan Avenue', 'exact'),
        ('name_only', None, None, 'West Side Avenue', 'exact'),
        ('name_only', None, None, 'West Side Avenue', 'base'),
        ('route_xs', '00000501__', 29.84, 'J F Kennedy Boulevard', 'route'),
        ('sri_mp', '09061684__', 1.2, 'West Side Avenue', None),
        ('sri_only', '09061575__', None, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.86, 'West Side Avenue', 'exact'),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, None),
    ]
    placed = out['loc_source'].isin(['intersection', 'route_xs'])
    assert out['lon'].notna().tolist() == placed.tolist()
