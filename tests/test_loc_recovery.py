from os.path import dirname, join
from types import SimpleNamespace

import duckdb
import numpy as np
import pandas as pd
import pytest
import shapely

from njdot.cc2mc2mn import cc2mc2mn
from njdot.cli.roads import build_geom, place_crashes, prep_crashes, road_outputs
from njdot.loc_recovery import (
    Snapper, base_key, clean_road, entity_at, junctions, learn_names, loc_key, meet_points, ng_name_index,
    nodir_key, offset_along, offset_m, recover, resolve_keys, route_keys, route_sri, seg_entities, split_road,
)
from njdot.map_base import _build_base
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
    # Alignment / express / secondary words pick the SRI's 9th / 10th characters; with the network's
    # SRIs, a secondary without an `…S` SRI takes the route's one other secondary.
    more = pd.Series(['I-95 Secondary Western Alignment', 'I-95 Express', 'I-78 Secondary', 'US 1 SECONDARY', 'NJ 495 Secondary'])
    assert route_sri(more, pd.Series([9] * 5)).tolist() == ['00000095WS', '00000095E_', '00000078_S', '00000001_S', '00000495_S']
    net = {'00000095WS', '00000095W_', '00000078__', '00000078_W', '00000001__', '00000001_S', '00000495__', '00000495_W', '00000095E_'}
    assert route_sri(more, pd.Series([9] * 5), net).tolist() == ['00000095WS', '00000095E_', '00000078_W', '00000001_S', '00000495_W']


def test_recode_county_routes():
    """2001–02 crashes naming a (non-500-series) county route but coded to the same-numbered state
    SRI get the county route's SRI (MP kept, NJDOT's point dropped); nothing else changes."""
    from njdot.loc_recovery import recode_county_routes
    cs = pd.DataFrame([
        (2002, 2, 'CR 29', '00000029__', 1.0),
        (2001, 2, 'BERGEN COUNTY 57 **', '00000057__', 2.49),
        (2002, 2, 'RT 17', '00000017__', 10.0),          # a state route's string
        (2002, 2, 'CR 503', '00000503__', 5.0),          # 500-series county routes are statewide
        (2003, 2, 'CR 29', '00000029__', 1.0),           # 2003+: coded right
        (2002, 2, 'CR 12', '00000029__', 1.0),           # another number
        (2002, 2, 'CR 29', '02000029__', 1.0),           # already the county route
        (2002, 4, 'CAMDEN COUNTY 705', '00000705__', None),
    ], columns=['year', 'cc', 'road', 'sri', 'mp']).assign(ilat=40.2, ilon=-74.7)
    out, n = recode_county_routes(cs)
    assert n == 3
    assert out['sri'].tolist() == ['02000029__', '02000057__', '00000017__', '00000503__', '00000029__', '00000029__', '02000029__', '04000705__']
    assert na(out['mp']) == [1.0, 2.49, 10.0, 5.0, 1.0, 1.0, 1.0, None]
    assert na(out['ilat']) == [None, None, 40.2, 40.2, 40.2, 40.2, 40.2, None]


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


def test_meet_junctions_offset():
    # A road along y=0 (x 0…1000 m), a cross street along x=400, another far away along x=900 (no meet).
    road = lines([(0, 0), (500, 0)], [(500, 0), (1000, 0)])
    cross = lines([(400, -200), (400, 0)], [(400, 0), (400, 200)])
    far = lines([(900, 50), (900, 300)])
    pts = meet_points(road, cross)
    assert sorted(map(tuple, pts.round(3).tolist())) == [(400.0, 0.0), (400.0, 0.0)]
    assert meet_points(road, far).shape == (0, 2)
    ps = junctions(pts, road)
    assert ps.round(3).tolist() == [[400.0, 0.0]]
    p = ps[0]
    assert offset_along(road, p, 100, 'E').round(3).tolist() == [500.0, 0.0]
    assert offset_along(road, p, 100, 'W').round(3).tolist() == [300.0, 0.0]
    # The road runs east-west: "N of the cross street" has nowhere to go.
    assert offset_along(road, p, 100, 'N') is None
    # No direction: at the intersection if near enough, else unplaceable.
    assert offset_along(road, p, 50, '').round(3).tolist() == [400.0, 0.0]
    assert offset_along(road, p, 100, '') is None
    # At a node the road goes on along the next segment (the nearest line, the first, ends there).
    assert offset_along(road, np.array([500.0, 0.0]), 100, 'E').round(3).tolist() == [600.0, 0.0]
    assert offset_along(road, np.array([500.0, 0.0]), 100, 'W').round(3).tolist() == [400.0, 0.0]


def test_junctions():
    # A road turning north at (100, 0); a cross street forking to meet it at (0, 0) and, through a
    # node (two meets), at (100, 140): 172 m apart, one junction (a triangle). Their meet-weighted
    # mean (66.7, 93.3) is 33 m off the road, so the junction is the meet nearest it.
    road = lines([(-100, 0), (100, 0)], [(100, 0), (100, 300)])
    pts = np.array([[0.0, 0.0], [100.0, 140.0], [100.0, 140.0]])
    assert junctions(pts, road).tolist() == [[100.0, 140.0]]
    # The same meets once each: the mean (50, 70) is off the road too, and equidistant from both;
    # the first.
    assert junctions(pts[:2], road).tolist() == [[0.0, 0.0]]
    # Meets 10 m apart (a divided road's carriageways crossing): their mean, on the road.
    assert junctions(np.array([[40.0, 0.0], [50.0, 0.0], [50.0, 0.0]]), road).round(2).tolist() == [[46.67, 0.0]]
    # Meets 600 m apart (a crescent meeting a street at both ends): two junctions, each where it meets.
    v = lines([(0, 0), (300, -300)], [(300, -300), (0, -600)])
    assert junctions(meet_points(v, lines([(0, 100), (0, -700)])), v).tolist() == [[0.0, -600.0], [0.0, 0.0]]
    # Meets all along a stretch the road shares with the cross street: no junction.
    along = np.array([[0.0, 0.0], [100.0, 0.0], [200.0, 0.0], [300.0, 0.0], [400.0, 0.0]])
    assert junctions(along, road).shape == (0, 2)
    assert junctions(np.empty((0, 2)), road).shape == (0, 2)


def test_sri_only_near_town():
    """An SRI without MP is on its one road (`sri_only`) only if that road comes within 2 km of the
    crash's muni: Elizabeth's "UNION COUNTY 624" crashes aren't on today's CR 624, Horseshoe Rd, 20 km
    away."""
    from njdot.loc_recovery import _locate_one
    town = shapely.multilinestrings([shapely.linestrings([(0, 0), (1000, 0)])])
    ctx = dict(
        lines=lines([(0, 0), (1000, 0)]), segs_by={}, segs_named={}, segs_cc={}, seg_ent=np.array([np.nan]), seg_sris=np.array([None], dtype=object),
        sri_lines={'NEAR': lines([(500, 1500), (500, 3000)]), 'FAR': lines([(20_000, 0), (21_000, 0)])}, ent_sris={}, sri_ent={'NEAR': 5, 'FAR': 6},
        snapper=None, muni_geoms={(20, 4): town},
    )
    assert _locate_one(20, 4, (), None, 'NEAR', pd.NA, 0.0, '', None, False, True, None, **ctx) == ('sri_only', 'NEAR', None, None, 5, None)
    assert _locate_one(20, 4, (), None, 'FAR', pd.NA, 0.0, '', None, False, True, None, **ctx) == ('none', None, None, None, None, None)
    # A muni with no streets known: not checked.
    assert _locate_one(20, 7, (), None, 'FAR', pd.NA, 0.0, '', None, False, True, None, **ctx) == ('sri_only', 'FAR', None, None, 6, None)


def test_locate_one_several_junctions():
    """A road meeting its cross street at both ends (Edison's Old Post Rd, US 1): the reported
    direction picks the junction the road leaves that way; with both possible, neither (flagged)."""
    from njdot.loc_recovery import _locate_one, _seg_groups
    # A "V" east of a north-south cross street (x = 0), meeting it at (0, 0) and (0, -600).
    segs = lines([(0, 0), (300, -300)], [(300, -300), (0, -600)], [(0, 100), (0, -700)])
    idx = pd.DataFrame([(9, 6, 'OLDPOSTRD', 0, 'name'), (9, 6, 'OLDPOSTRD', 1, 'name'), (9, 6, 'USRT1', 2, 'name')], columns=['cc', 'mc', 'key', 'seg', 'src'])
    snapper = SimpleNamespace(snap=lambda q, sris: ('OPR', round(float(q[0]) / 1000, 3), 0.0))
    ctx = dict(
        lines=segs, segs_by=_seg_groups(idx, ['cc', 'mc', 'key']), segs_named=_seg_groups(idx[idx['src'] == 'name'], ['cc', 'mc', 'key']),
        segs_cc=_seg_groups(idx, ['cc', 'key']), seg_ent=np.array([7.0, 7.0, 8.0]), seg_sris=np.array(['OPR', 'OPR', 'US1'], dtype=object),
        sri_lines={}, ent_sris={}, sri_ent={}, snapper=snapper,
    )

    def locate(off, dirn):
        res = _locate_one(9, 6, ('OLDPOSTRD',), ('USRT1',), pd.NA, pd.NA, off, dirn, None, False, False, None, **ctx)
        return res[:3] + (None if res[3] is None else res[3].round(1).tolist(),) + res[4:]

    # 100 m south of US 1: only from the north junction does the road run south.
    assert locate(100.0, 'S') == ('intersection', 'OPR', 0.071, [70.7, -70.7], None, None)
    # … north: only from the south one.
    assert locate(100.0, 'N') == ('intersection', 'OPR', 0.071, [70.7, -529.3], None, None)
    # East, or at the intersection: either junction; on the road by its name, no point.
    assert locate(100.0, 'E') == ('name_only', None, None, None, 7, 'junctions')
    assert locate(0.0, '') == ('name_only', None, None, None, 7, 'junctions')


def test_locate_strings_road_aliased_on_cross_street():
    """NG9-1-1 aliases 17 of Edison's 20 Vineyard Road segments "Old Post Road": an "OLD POST RD" ×
    "VINEYARD RD" crash met the cross street all along their shared stretch (ambiguous → name-only).
    The shared segments can't be where they cross, so the road is the segments carrying its name as
    their own: Old Post Road (along y = 0) ends at Vineyard Road (x = 500, running north)."""
    from njdot.loc_recovery import _locate_strings, _seg_groups
    segs = lines([(0, 0), (500, 0)], [(500, 0), (500, 300)], [(500, 300), (500, 600)], [(500, 600), (500, 900)])
    idx = pd.DataFrame([
        (9, 6, 'OLDPOSTRD', 0, 'name'), (9, 6, 'OLDPOSTRD', 1, 'alias'), (9, 6, 'OLDPOSTRD', 2, 'alias'),
        (9, 6, 'VINEYARDRD', 1, 'name'), (9, 6, 'VINEYARDRD', 2, 'name'), (9, 6, 'VINEYARDRD', 3, 'name'),
    ], columns=['cc', 'mc', 'key', 'seg', 'src'])
    ctx = dict(
        lines=segs, segs_by=_seg_groups(idx, ['cc', 'mc', 'key']), segs_named=_seg_groups(idx[idx['src'] == 'name'], ['cc', 'mc', 'key']),
        segs_cc=_seg_groups(idx, ['cc', 'key']), seg_ent=np.array([7.0, 8.0, 8.0, 8.0]), seg_sris=np.array(['OPR', 'VIN', 'VIN', 'VIN'], dtype=object),
        sri_lines={}, ent_sris={}, sri_ent={}, snapper=None,
    )
    r_lines, r_sris, kind, ps, rest = _locate_strings(9, 6, ('OLDPOSTRD',), ('VINEYARDRD',), None, None, None, False, False, **ctx)
    assert (len(r_lines), sorted(r_sris), kind, ps.round(3).tolist(), rest) == (1, ['OPR'], 'intersection', [[500.0, 0.0]], ('name_only', None, None, None, 7))


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


def test_snapper_point_and_far_from_town(real):
    """`Snapper.point` inverts `snap`; `far_from_town` flags coded crashes whose point (NJDOT's, else
    the SRI / MP's) is > 2 km from their muni's streets: West Side Ave MP 1.2 is in Jersey City (9, 6),
    not in a muni 50 km away (9, 99); without a point, a muni or an MP, nothing is checked."""
    from njdot.loc_recovery import far_from_town, muni_geoms
    p = real.snapper.point('09061684__', 1.2)
    s, mp, d = real.snapper.snap(p, {'09061684__'})
    assert (s, round(mp, 3), round(d, 3)) == ('09061684__', 1.2, 0.0)
    assert real.snapper.point('09061684__', 99.0) is None
    geoms = muni_geoms(real.seg['line'].to_numpy(), real.idx)
    far = shapely.multilinestrings([shapely.linestrings([(p[0] + 50_000, p[1]), (p[0] + 51_000, p[1])])])
    geoms[(9, 99)] = far
    cs = pd.DataFrame({
        'cc': [9, 9, 9, 9, 9, 9], 'mc': [6, 99, 99, 99, 98, 6],
        'sri': ['09061684__', '09061684__', '09061684__', '09061684__', '09061684__', None],
        'mp': [1.2, 1.2, 1.2, None, 1.2, None],
        'ilat': [None, None, 40.73, None, None, None], 'ilon': [None, None, -74.07, None, None, None],
    })
    # (Row 2 is checked by NJDOT's point, without the snapper too; row 4's muni has no streets known.)
    assert far_from_town(cs, geoms, real.snapper).tolist() == [False, True, True, False, False, False]
    assert far_from_town(cs, geoms).tolist() == [False, False, True, False, False, False]
    assert far_from_town(cs, None, real.snapper).tolist() == [False] * 6
    # A road that comes through the muni keeps its crashes (the MP is off, not the road): with a
    # 500 m tolerance, muni 97 is a street crossing West Side Ave at MP 0.3, 0.9 mi from MP 1.2.
    q = real.snapper.point('09061684__', 0.3)
    geoms[(9, 97)] = shapely.multilinestrings([shapely.linestrings([(q[0] - 50, q[1]), (q[0] + 50, q[1])])])
    c97 = cs.assign(mc=[97, 99, 99, 99, 98, 97])
    assert far_from_town(c97, geoms, real.snapper, town_m=500).tolist() == [True, True, True, False, False, False]
    assert far_from_town(c97, geoms, real.snapper, real.runs, town_m=500).tolist() == [False, True, True, False, False, False]


def test_recover_real(real):
    cs = pd.DataFrame([
        crash('WESTSIDE AVE', 'DUNCAN AVE', unit='AT'),
        # 500 ft S / N of Duncan Ave: on West Side Ave's SRI south of it / the next one north.
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
        # A current SRI at an MP no current run holds (a cut-back SRI: pre-2018 CR 697 ran on past
        # today's end): re-located too, by name; failing that it keeps its SRI / MP, on no road (not
        # `sri_only` onto the SRI's current entity, which the MP says it isn't on).
        crash('WEST SIDE AVE', 'DUNCAN AVE', sri='09061684__', mp=4.0, dist=500, unit='FE', d='S'),
        crash('XYZ', sri='09061575__', mp=0.9),
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
        ('intersection', '09061575__', 0.06, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.99, 'Duncan Avenue', 'exact'),
        ('name_only', None, None, 'West Side Avenue', 'exact'),
        ('name_only', None, None, 'West Side Avenue', 'base'),
        ('route_xs', '00000501__', 29.84, 'J F Kennedy Boulevard', 'route'),
        ('sri_mp', '09061684__', 1.2, 'West Side Avenue', None),
        ('sri_only', '09061575__', None, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.86, 'West Side Avenue', 'exact'),
        ('intersection', '09061684__', 1.86, 'West Side Avenue', 'exact'),
        ('sri_mp', '09061575__', 0.9, None, None),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, 'exact'),
        ('none', None, None, None, None),
    ]
    placed = out['loc_source'].isin(['intersection', 'route_xs'])
    assert out['lon'].notna().tolist() == placed.tolist()

    # The per-crash loop in forked processes gives the same result (as `recover_unassigned` does
    # statewide; here forced on, with crashes from two munis).
    import njdot.loc_recovery as lr
    more = pd.concat([cs, cs.assign(mc=7), cs], ignore_index=True)
    serial = recover(more, real.seg, real.idx, real.seg_ent, real.seg_sris, real.snapper, real.runs)
    par_min, procs = lr.PAR_MIN_ROWS, lr.RECOVER_PROCS
    lr.PAR_MIN_ROWS, lr.RECOVER_PROCS = 0, 2
    try:
        par = recover(more, real.seg, real.idx, real.seg_ent, real.seg_sris, real.snapper, real.runs)
    finally:
        lr.PAR_MIN_ROWS, lr.RECOVER_PROCS = par_min, procs
    pd.testing.assert_frame_equal(par, serial)


def test_close_matcher_is_get_close_matches():
    from difflib import get_close_matches
    from njdot.loc_recovery import CloseMatcher
    words = ['AUDUBONAVE', 'AUDIBONAVE', 'WESTSIDEAVE', 'WESTSIDEPL', 'BERGENAVE', 'BERGENLN', 'KENNEDYBLVD', 'JFKENEDYBLVD', 'MLKDR', '']
    cm = CloseMatcher(words)
    queries = ['AUDOBONAVE', 'WESTSIDEAV', 'BERGENAV', 'JFKENNEDYBLVD', 'X', '', 'ZZZZZZZ', 'WESTSIDEAVE']
    for q in queries:
        for cutoff in (0.6, 0.88):
            assert cm.close_matches(q, n=2, cutoff=cutoff) == get_close_matches(q, words, n=2, cutoff=cutoff), (q, cutoff)
    assert cm.close_matches('AUDOBONAVE', n=2, cutoff=0.88) == ['AUDUBONAVE', 'AUDIBONAVE']


def build_fixture(recover: bool) -> dict:
    """`njdot roads build`'s crash placement + outputs over the real fixtures and the West Side Ave
    crash fixture (Jersey City crashes whose `road` / `cross_street` names West Side Ave, 2006 /
    2016 / 2019)."""
    con = duckdb.connect()
    cl = pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet'))
    al = pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet'))
    b = build_geom(pd.read_parquet(join(FIXTURES, 'roadway_network.parquet')), cl, al, con)
    crashes = prep_crashes(pd.read_parquet(join(FIXTURES, 'crashes.parquet')))
    by_sri, by_entity = place_crashes(crashes, _build_base(crashes, keep_severities=set()), b, cl, al, con, recover=recover)
    o = road_outputs(b, by_sri, by_entity, con, cc2mc2mn)
    o['crashes'] = crashes
    o['slug'] = o['ents'].set_index('entity')['slug']
    return o


@pytest.fixture(scope='module')
def built():
    return SimpleNamespace(before=build_fixture(recover=False), after=build_fixture(recover=True))


WSA = 'hudson/jersey-city/west-side-avenue'


def year_counts(o: dict, slug: str) -> list[list]:
    s = o['road-summary']
    s = s[s['entity'].map(o['slug']).eq(slug).to_numpy()]
    return s.groupby('year')[['n', 'n_unplaced']].sum().reset_index().values.tolist()


def test_build_recovers_west_side_ave(built):
    before, after = built.before, built.after
    # Without recovery, pre-2018 West Side Ave has only the crashes NJDOT coded an SRI / MP for.
    assert year_counts(before, WSA) == [[2006, 2, 0], [2016, 7, 0], [2019, 164, 0]]
    # With it: police strings put ~50x more 2006 / 2016 crashes on it, most by name only (this
    # fixture's NG911 has few of the cross streets); 2019 (already coded) barely moves.
    assert year_counts(after, WSA) == [[2006, 107, 96], [2016, 126, 110], [2019, 172, 8]]
    be = after['by_entity']
    wsa = be[be['entity'].map(after['slug']).eq(WSA).to_numpy()]
    assert wsa.groupby(['year', 'loc_source']).size().reset_index().values.tolist() == [
        [2006, 'intersection', 9], [2006, 'name_only', 96], [2006, 'sri_mp', 2],
        [2016, 'intersection', 9], [2016, 'name_only', 110], [2016, 'sri_mp', 7],
        [2019, 'name_only', 8], [2019, 'sri_mp', 164],
    ]
    # Unplaced (name-only) crashes sort last on the road, with no SRI / MP / point.
    unpl = wsa['loc_source'].eq('name_only').to_numpy()
    assert unpl.tolist() == [False] * 191 + [True] * 214
    assert wsa[unpl][['sri', 'mp', 'lat', 'lon']].notna().sum().tolist() == [0, 0, 0, 0]
    # Placed recoveries have a recovered SRI / MP and point.
    assert wsa[wsa['loc_source'].eq('intersection').to_numpy()][['sri', 'mp', 'lat', 'lon']].notna().all().tolist() == [True] * 4
    # `road-entities` counts every assigned crash.
    ents = after['ents'].set_index('slug')
    assert ents.loc[WSA, 'n_crashes'] == 405
    assert before['ents'].set_index('slug').loc[WSA, 'n_crashes'] == 173


def test_build_recovery_keeps_coded_and_private(built, real):
    before, after = built.before, built.after

    def ids(o, src=None):
        be = o['by_entity']
        if src:
            be = be[be['loc_source'].eq(src).to_numpy()]
        return sorted(zip(be['id'].astype(int), be['entity'].map(o['slug'])))

    # Coded crashes stay exactly where they were.
    assert ids(after, 'sri_mp') == ids(before)
    # `crashes-by-sri` gains the placed recoveries; name-only crashes (no SRI) aren't in it.
    assert after['by_sri']['loc_source'].value_counts().sort_index().to_dict() == {'intersection': 19, 'none': 5, 'sri_mp': 354}
    assert len(before['by_sri']) == 359
    # `how` (audit) is only in `crashes-by-sri`, and only on crashes recovery tried and whose road
    # name resolved (the 5 "none" are "HUDSON COUNTY 6xx" strings coded with retired county-route
    # SRIs that this fixture's network and NG911 names lack).
    assert 'how' not in after['by_entity']
    assert after['by_sri'].groupby('loc_source')['how'].count().to_dict() == {'intersection': 19, 'none': 0, 'sri_mp': 0}
    # Private property (`road_system` 9) is never recovered: the fixture's 16 private crashes stay
    # off every road.
    cr = after['crashes']
    private = cr['road_system'].eq(9).fillna(False).to_numpy()
    assert private.sum() == 16
    assert after['by_entity']['id'].isin(set(cr.loc[private, 'id'])).sum() == 0
    # … which is the guard's doing: as municipal-road crashes, most would be recovered.
    priv = cr[private]
    args = (real.seg, real.idx, real.seg_ent, real.seg_sris, real.snapper, real.runs)
    assert recover(priv, *args)['loc_source'].astype(str).value_counts().to_dict() == {'none': 16}
    assert recover(priv.assign(road_system=7), *args)['loc_source'].astype(str).value_counts().to_dict() == {'name_only': 12, 'none': 4}
