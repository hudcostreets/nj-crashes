"""Road model v5 (`njdot.road_model`, specs/road-model-v5.md): chainage, corridors, intersection nodes,
crash ↔ node association, and the build outputs on the real Hudson fixtures."""
from os.path import dirname, join
from types import SimpleNamespace

import duckdb
import numpy as np
import pandas as pd
import pytest

from njdot.cc2mc2mn import cc2mc2mn
from njdot.cli.roads import build_geom, place_crashes, prep_crashes, road_outputs, road_runs
from njdot.loc_recovery import Snapper, calibrate_retired, sri_entities
from njdot.map_base import _build_base
from njdot.road_model import (
    MI_M, XS_M, block_of, block_pos, block_stats, chain_at, corridor_only_rows, corridor_pairs, crash_nodes, entity_pieces,
    road_blocks, road_corridors, stated_m, xs_rows,
)
from njdot.road_net import dir_key, ng_name, road_entities, rn_features, to_meters
from njdot.road_outputs import road_summary

FIXTURES = join(dirname(__file__), 'data', 'roads')
LAT = 40.70
# Degrees of longitude per meter at `LAT`.
DEG_M = 1 / (111_320 * np.cos(np.radians(LAT)))


def lon_at(x_m: float) -> float:
    return -74.0 + x_m * DEG_M


def r(xs, n=4):
    return [None if pd.isna(x) else round(float(x), n) for x in xs]


def test_dir_key():
    names = pd.Series(['West 48th Street', 'East 48th Street', 'W 48TH ST', 'North Avenue East', 'North Avenue', 'West Side Avenue', 'Boulevard East', 'Main Street'])
    assert dir_key(names).tolist() == ['48THST', '48THST', '48THST', 'NORTHAVE', 'NORTHAVE', 'SIDEAVE', 'BLVDEAST', 'MAINST']


def test_ng_name_placeholders():
    s = pd.Series(['Unnamed Segment', 'Unnamed Segment Road', ' Main St ', '', 'RAMP', 'Ramapo Road', 'Driveway', None])
    assert [None if pd.isna(v) else v for v in ng_name(s)] == [None, None, 'Main St', None, None, 'Ramapo Road', None, None]


def ew_geom() -> pd.DataFrame:
    """"West 48th Street" (S0) then "East 48th Street" (S1) end to end along `LAT`, 3 points each ~50 m apart."""
    rows = []
    for k, (sri, name) in enumerate([('S0', 'West 48th Street'), ('S1', 'East 48th Street')]):
        for j in range(3):
            rows.append({'sri': sri, 'mp': 0.03 * j, 'sld_name': 'X', 'name': name, 'subt': np.int8(7), 'lon': lon_at(50 * (3 * k + j)), 'lat': LAT, 'cc': 9, 'seg': 0})
    g = pd.DataFrame(rows)
    g['cc'] = g['cc'].astype('Int8')
    return g


def test_direction_variants_are_separate_entities_in_one_corridor():
    """NG911 aliases East 48th Street "West 48th Street" (Bayonne): v4 joined them into one entity;
    now they're two entities, one corridor."""
    geom = ew_geom()
    runs, point_run = road_runs(geom)
    names = pd.DataFrame([(1, 'L', 'West 48th Street', 3)], columns=['run', 'kind', 'value', 'n'])
    runs['entity'] = road_entities(runs, geom, point_run, names)
    assert runs['entity'].tolist() == [0, 1]
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    pieces = entity_pieces(runs, {})
    geom['chain'] = chain_at(geom['entity'], geom['sri'], geom['mp'], pieces, {})
    ents = pd.DataFrame({'entity': [0, 1], 'name': ['West 48th Street', 'East 48th Street'], 'subt': [7, 7], 'cc': [9, 9]})
    pairs = corridor_pairs(ents, runs, geom, pieces, {})
    assert pairs.values.tolist() == [[0, 1, 'sequential']]
    cor, mem = road_corridors(ents, pairs, geom, pieces)
    assert cor[['name', 'kind', 'spine']].values.tolist() == [['48th Street', 'sequential', 0]]
    # West (the spine, chain 0-0.06) then East, 50 m (0.031 mi) further along.
    assert [(e, ro, round(float(c0), 3), int(s)) for e, ro, c0, s in mem[['entity', 'role', 'c0', 'sign']].values] == [
        (0, 'spine', 0.0, 1), (1, 'sequential', 0.091, 1),
    ]


def fwy_case(names: list[str], subts: list[int]) -> tuple:
    """Entities end to end on one SRI `F` (MP 0–0.1, 0.1–0.2, …), 3 points each, along `LAT`."""
    rows = []
    for k, (name, subt) in enumerate(zip(names, subts)):
        for j in range(3):
            mp = round(0.1 * k + 0.05 * j, 2)
            rows.append({'sri': 'F', 'mp': mp, 'sld_name': 'X', 'name': name, 'subt': np.int8(subt), 'lon': lon_at(mp * MI_M), 'lat': LAT, 'cc': 9, 'seg': 0, 'entity': k})
    geom = pd.DataFrame(rows).astype({'cc': 'Int8'})
    runs = pd.DataFrame([
        {'entity': k, 'sri': 'F', 'mp_lo': round(0.1 * k, 2), 'mp_hi': round(0.1 * k + 0.1, 2), 'mp_end': round(0.1 * k + 0.1, 2),
         'lon0': lon_at(0.1 * k * MI_M), 'lat0': LAT, 'lon1': lon_at((0.1 * k + 0.1) * MI_M), 'lat1': LAT}
        for k in range(len(names))
    ])
    pieces = entity_pieces(runs, {})
    geom['chain'] = chain_at(geom['entity'], geom['sri'], geom['mp'], pieces, {})
    ents = pd.DataFrame({'entity': range(len(names)), 'name': names, 'subt': subts, 'cc': [9] * len(names)})
    return ents, runs, geom, pieces


def test_freeway_continuations_are_one_corridor():
    """Consecutive runs of one SRI are one road when both are limited-access (`FREEWAY_SUBT`: 1
    interstate, 4 toll road) whatever NG9-1-1 names them ("Pearl Harbor Memorial Bridge" continuing
    the "New Jersey Turnpike Extension"), but not a city street carrying the route (JC's "12th
    Street" on I-78), nor local roads. The spine names the corridor, and isn't an express / secondary
    carriageway even when that's (slightly) longer."""
    ents, runs, geom, pieces = fwy_case(['Pearl Harbor Memorial Bridge', 'New Jersey Turnpike Extension', '12th Street'], [1, 1, 1])
    assert corridor_pairs(ents, runs, geom, pieces, {}).values.tolist() == [[0, 1, 'sequential']]
    ents, runs, geom, pieces = fwy_case(['Walt Whitman Bridge', 'Interstate 76', 'Oak Road'], [1, 4, 7])
    assert corridor_pairs(ents, runs, geom, pieces, {}).values.tolist() == [[0, 1, 'sequential']]
    ents, runs, geom, pieces = fwy_case(['Elm Street', 'Maple Street', 'Oak Road'], [7, 7, 7])
    assert corridor_pairs(ents, runs, geom, pieces, {}).values.tolist() == []
    # Spine: "… Express" (0.1 mi longer here) loses to the main line.
    ents, runs, geom, pieces = fwy_case(['New Jersey Turnpike', 'New Jersey Turnpike Express', 'Oak Road'], [1, 1, 7])
    pieces.loc[pieces['entity'] == 1, 'chain_hi'] += 0.1
    cor, mem = road_corridors(ents, corridor_pairs(ents, runs, geom, pieces, {}), geom, pieces)
    assert cor[['name', 'spine']].values.tolist() == [['New Jersey Turnpike', 0]]


def piece_runs() -> pd.DataFrame:
    """One entity, three pieces, in meters along `LAT`: A (MP 0–1, 0 → 1609 m), then B (MP 5–5.5)
    running *backwards* from 1629 m (its MP 5.5 end) to 2434 m, then C (MP 0–0.2) 1 km past B;
    plus A's secondary carriageway `A_S` (parent MPs 0.2–0.8)."""
    def run(sri, lo, hi, x0, x1):
        return {'entity': 0, 'sri': sri, 'mp_lo': lo, 'mp_hi': hi, 'mp_end': hi, 'lon0': lon_at(x0), 'lat0': LAT, 'lon1': lon_at(x1), 'lat1': LAT}
    return pd.DataFrame([
        run('A', 0.0, 1.0, 0, 1609), run('A_S', 0.2, 0.8, 322, 1287), run('B', 5.0, 5.5, 2434, 1629), run('C', 0.0, 0.2, 3434, 3756),
    ])


def test_entity_pieces_order_direction_and_gaps():
    p = entity_pieces(piece_runs(), {'A_S': 'A'})
    assert [(pc, s, lo, hi, int(d), round(c0, 4), round(c1, 4), j, round(float(g), 4)) for pc, s, lo, hi, d, c0, c1, j, g in p[['piece', 'sri', 'mp_lo', 'mp_hi', 'dir', 'chain_lo', 'chain_hi', 'join', 'gap_mi']].values] == [
        (0, 'A', 0.0, 1.0, 1, 0.0, 1.0, 'start', 0.0),
        # 20 m from A's end: contiguous; runs high → low MP.
        (1, 'B', 5.0, 5.5, -1, 1.0124, 1.5124, 'contiguous', 0.0124),
        # 1 km past B: a branch; its gap is capped.
        (2, 'C', 0.0, 0.2, 1, 1.7624, 1.9624, 'branch', 0.25),
    ]


def test_chain_at_pieces_and_secondaries():
    parent = {'A_S': 'A'}
    p = entity_pieces(piece_runs(), parent)
    q = pd.DataFrame([
        (0, 'A', 0.5), (0, 'A_S', 0.5),  # a secondary carriageway measures on its parent's MPs
        (0, 'B', 5.5), (0, 'B', 5.1), (0, 'C', 0.1), (0, 'D', 0.1), (1, 'A', 0.5), (0, 'A', None),
    ], columns=['entity', 'sri', 'mp'])
    assert r(chain_at(q['entity'], q['sri'], q['mp'], p, parent)) == [0.5, 0.5, 1.0124, 1.4124, 1.8624, None, None, None]


def test_sri_entities_county_scoped():
    """CR 501 is several roads statewide but only J F Kennedy Blvd in Hudson: a Hudson crash coded
    `00000501__` with no MP is on it (the statewide vs `-C 9` JFK count mismatch)."""
    runs = pd.DataFrame({
        'sri': ['00000501__'] * 4 + ['09061684__'], 'entity': [1, 2, 7, 7, 9], 'cc': pd.array([12, 12, 9, 9, 9], dtype='Int8'),
    })
    assert sri_entities(runs) == {'09061684__': 9, ('00000501__', 9): 7, ('09061684__', 9): 9}


def line_feats(sri: str, x0: float, x1: float, ms: float, me: float) -> pd.DataFrame:
    """A one-feature Roadway Network frame: `sri` along `LAT` from `x0` to `x1` meters, MPs `ms`–`me`."""
    xs = np.linspace(x0, x1, 5)
    return pd.DataFrame([{
        'SRI': sri, 'ROUTE_SUBTYPE': 7, 'SLD_NAME': sri, 'PARENT_SRI': None, 'MP_START': ms, 'MP_END': me,
        'PARENT_MP_START': None, 'PARENT_MP_END': None, 'x': [lon_at(x) for x in xs], 'y': [LAT] * 5,
        'm': list(np.linspace(ms, me, 5)),
    }])


def test_calibrate_retired_sri():
    """A retired SRI `OLD` (MPs 0–1 along today's `NEW`, MP 2–3): a crash's MP is interpolated
    between the anchors (crashes with points) around it; one between anchors > `CAL_MAX_SPAN_MI`
    apart, or past the last anchor by > `CAL_NEAR_MI`, stays unplaced; so do crashes on an SRI whose
    anchors bunch within 0.1 mi (a stub's crashes at the street it starts on: its line and the cross
    street's can't be told apart)."""
    feats = rn_features(line_feats('NEW', 0, MI_M, 2.0, 3.0))
    snap = Snapper(feats)
    x0, y0 = to_meters([lon_at(0)], [LAT])
    x0, y0 = x0[0], y0[0]
    anchors = [0.1, 0.25, 0.4, 0.9]
    queries = [0.3, 0.6, 0.97, 0.91]
    sri = np.array(['OLD'] * 8 + ['STUB'] * 4, dtype=object)
    mp = np.array(anchors + queries + [0.0, 0.02, 0.04, 0.01])
    ax = np.array([x0 + m * MI_M for m in anchors] + [np.nan] * 4 + [x0 + 5, x0 + 20, x0 + 40, np.nan])
    ay = np.array([y0] * 4 + [np.nan] * 4 + [y0] * 3 + [np.nan])
    anchor = np.isfinite(ax)
    out = calibrate_retired(sri, mp, ax, ay, anchor, ~anchor, snap)
    assert {i: (s, round(m, 2)) for i, (s, m, _) in out.items()} == {4: ('NEW', 2.3), 7: ('NEW', 2.9)}


def test_calibrate_retired_skips_ramps():
    """A route's retired MPs aren't calibrated onto a ramp: here the only current line along the
    anchors is a ramp SRI (`NEW` + a ramp id), so nothing is placed; a ramp's own retired SRI can be."""
    ramp = 'NEW_______A100'
    feats = rn_features(line_feats(ramp, 0, MI_M, 2.0, 3.0))
    snap = Snapper(feats)
    x0, y0 = to_meters([lon_at(0)], [LAT])
    anchors = [0.1, 0.25, 0.4, 0.9]
    for old, placed in (('OLD', {}), ('OLD_______A100', {4: (ramp, 2.3)})):
        sri = np.array([old] * 5, dtype=object)
        mp = np.array(anchors + [0.3])
        ax = np.array([x0[0] + m * MI_M for m in anchors] + [np.nan])
        ay = np.array([y0[0]] * 4 + [np.nan])
        anchor = np.isfinite(ax)
        out = calibrate_retired(sri, mp, ax, ay, anchor, ~anchor, snap)
        assert {i: (s, round(m, 2)) for i, (s, m, _) in out.items()} == placed


# --- Crash ↔ node -----------------------------------------------------------------------------

# Road 0 (local, `subt` 7) and road 1 (state, `subt` 3) cross at node 5 (road 0's chain 1.0, road 1's
# 2.0); road 0 also meets "Oak Street" (no entity) at node 6 (chain 1.3).
NODE_ENTS = pd.DataFrame({'node': [5, 5, 6], 'entity': [0, 1, 0], 'chain': [1.0, 2.0, 1.3]}).astype({'node': 'int32', 'entity': 'int32'})
# `node_keys`: road 0 ("Elm Ave") sees "Maple St" (road 1) at node 5 and "Oak St" at node 6; road 1
# sees "Elm Ave" at node 5.
NK = pd.DataFrame([
    (0, 'MAPLEST', 5, 1.0, 1.0), (1, 'ELMAVE', 5, 2.0, 0.0), (0, 'OAKST', 6, 1.3, np.nan),
], columns=['entity', 'key', 'node', 'chain', 'leg_ent'])
IDX = pd.DataFrame({'cc': [9, 9, 9], 'mc': [6, 6, 6], 'key': ['MAPLEST', 'ELMAVE', 'OAKST'], 'base': ['MAPLE', 'ELM', 'OAK']})
SUBT = pd.Series({0: 7, 1: 3})


def xs_crash(entity, chain, cross, flag='B', dist=None, unit=None, road='ELM AVE'):
    return {'entity': entity, 'chain': chain, 'cc': 9, 'mc': 6, 'road': road, 'cross_street': cross,
            'Intersection': flag, 'cross_street_distance': dist, 'Unit Of Measurement': unit}


def test_crash_nodes_rules():
    ft = 0.3048 / MI_M  # a foot, in chain miles
    be = pd.DataFrame([
        xs_crash(0, 1.0, 'MAPLE ST', 'I', None, 'AT'),              # 0: named, at the intersection
        xs_crash(0, 1.0 + 40 * ft, 'MAPLE ST', 'B', 40, 'FE'),      # 1: local road, 40 ft ≤ 50 ft
        xs_crash(0, 1.0 + 100 * ft, 'MAPLE ST', 'B', 100, 'FE'),    # 2: local road, 100 ft > 50 ft: not at it
        xs_crash(1, 2.0 + 100 * ft, 'ELM AVE', 'B', 100, 'FE', road='MAPLE ST'),  # 3: state road, 100 ft ≤ 100 ft
        xs_crash(0, 1.0 + 300 / MI_M, 'MAPLE ST', 'I', None, 'AT'),  # 4: named, but its point is 300 m off
        xs_crash(0, 1.3 + 5 / MI_M, None, 'I', None, 'AT'),          # 5: no cross street, flagged, 5 m from node 6
        xs_crash(0, 1.3 + 40 / MI_M, None, 'I', None, 'AT'),         # 6: … 40 m: too far for a local road
        xs_crash(0, 1.0 + 10 / MI_M, 'MAPLE ST', 'No', None, None),  # 7: AASHTO: no distance; 10 m by its point
        xs_crash(0, np.nan, 'MAPLE ST', 'I', None, 'AT'),            # 8: unplaced, named: pinned at the node
        xs_crash(0, np.nan, 'MAPLE ST', 'B', 200, 'FE'),             # 9: unplaced, 200 ft: an interval, not at it
        xs_crash(0, 1.3, 'OAK ST', 'I', None, 'AT'),                 # 10: a cross street on no entity
    ])
    out = crash_nodes(be, NK, NODE_ENTS, IDX, SUBT)
    assert [(None if pd.isna(n) else int(n), None if pd.isna(h) else h) for n, h in zip(out['node'], out['xs_how'])] == [
        (5, 'named'), (5, 'named'), (None, None), (5, 'named'), (None, None), (6, 'geom'), (None, None), (5, 'named'),
        (5, 'named'), (None, None), (6, 'named'),
    ]
    assert r(out['xs_d_m'], 1) == [0.0, 12.2, None, 30.5, None, 5.0, None, 10.0, None, None, 0.0]
    assert r(out['chain_lo'], 5) == [None] * 8 + [1.0, round(1.0 - 200 * ft, 5), None]
    assert r(out['chain_hi'], 5) == [None] * 8 + [1.0, round(1.0 + 200 * ft, 5), None]
    assert r(stated_m(be)[1], 2) == [0.0, 12.19, 30.48, 30.48, 0.0, 0.0, 0.0, None, 0.0, 60.96, 0.0]
    assert {k: round(v, 2) for k, v in XS_M.items()} == {1: 30.49, 2: 30.49, 3: 30.49, 4: 22.87, 5: 22.87, 6: 22.87, 7: 15.25}


def test_xs_rows_and_inclusive_summary():
    """A crash at a node counts on the node's other roads too (`xs`): exclusive `n` still sums to the
    total, inclusive = `n + n_xs`."""
    be = pd.DataFrame({
        'entity': [0, 0, 1], 'chain': [1.0, 0.2, 2.0], 'node': pd.array([5, pd.NA, 5], dtype='Int32'), 'year': [2020, 2020, 2021],
        'severity': ['i', 'p', 'f'], 'tk': [0, 0, 1], 'ti': [1, 0, 0], 'dt': pd.to_datetime(['2020-01-01', '2020-02-01', '2021-03-01']),
        'loc_source': ['sri_mp'] * 3, 'case': ['a', 'b', 'c'],
    })
    xs = xs_rows(be, NODE_ENTS, SUBT)
    assert xs[['entity', 'own_entity', 'chain', 'case']].values.tolist() == [[1, 0, 2.0, 'a'], [0, 1, 1.0, 'c']]
    s = road_summary(be, xs=xs)
    assert s.values.tolist() == [
        [0, 2020, 'i', 1, 0, 1, 0, 1, 0, 0, 0],
        [0, 2020, 'p', 1, 0, 0, 0, 0, 0, 0, 0],
        [0, 2021, 'f', 0, 0, 0, 0, 0, 1, 1, 0],
        [1, 2020, 'i', 0, 0, 0, 0, 0, 1, 0, 1],
        [1, 2021, 'f', 1, 1, 0, 0, 1, 0, 0, 0],
    ]
    assert s.columns.tolist() == ['entity', 'year', 'severity', 'n', 'tk', 'ti', 'n_unplaced', 'n_node', 'n_xs', 'tk_xs', 'ti_xs']


def test_road_blocks_cut_at_nodes_and_gaps():
    pieces = entity_pieces(piece_runs(), {'A_S': 'A'})
    ne = pd.DataFrame({'node': [3, 4, 5], 'entity': [0, 0, 0], 'chain': [0.4, 0.402, 1.2]}).astype({'node': 'int32', 'entity': 'int32'})
    b = road_blocks(ne, pieces)
    assert [(k, round(lo, 4), round(hi, 4), None if pd.isna(a) else int(a), None if pd.isna(z) else int(z)) for k, lo, hi, a, z in b[['block', 'chain_lo', 'chain_hi', 'node_lo', 'node_hi']].values] == [
        (0, 0.0, 0.4, None, 3),
        # node 4 is 0.002 mi (3 m) past node 3: one cut
        (1, 0.4, 1.2, 3, 5),
        # Cut at B's end: no block over the branch join (1.5124–1.7624), where there's no road.
        (2, 1.2, 1.5124, 5, None),
        (3, 1.7624, 1.9624, None, None),
    ]
    assert b.dtypes.astype(str).tolist() == ['int32', 'int32', 'float32', 'float32', 'Int32', 'Int32']
    # A crash row's block: the last block starting at or before it (float32), the first below all.
    c_lo = b['chain_lo'].tolist()
    pos = pd.Series([0.0, 0.3999, 0.4, 1.2, 1.5124, 1.6, c_lo[3], 1.9624, -0.001, np.nan, 0.5])
    ent = pd.Series([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])
    assert block_of(b, ent, pos).tolist() == [0, 0, 1, 2, 2, 2, 3, 3, 0, pd.NA, pd.NA]
    # A crash at a node is in the block that starts there, wherever its own point is.
    be = pd.DataFrame({'entity': [0, 0, 0, 0], 'chain': [0.39, 0.41, 0.39, np.nan], 'node': pd.array([3, 3, pd.NA, 5], dtype='Int32')})
    assert r(block_pos(be, ne)) == [0.4, 0.4, 0.39, None]
    assert block_of(b, be['entity'], block_pos(be, ne)).tolist() == [1, 1, 0, pd.NA]


# --- Real fixtures (build) ---------------------------------------------------------------------


@pytest.fixture(scope='module')
def built():
    con = duckdb.connect()
    cl = pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet'))
    al = pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet'))
    b = build_geom(pd.read_parquet(join(FIXTURES, 'roadway_network.parquet')), cl, al, con)
    crashes = prep_crashes(pd.read_parquet(join(FIXTURES, 'crashes.parquet')))
    by_sri, by_entity = place_crashes(crashes, _build_base(crashes, keep_severities=set()), b, cl, al, con, recover=True)
    o = road_outputs(b, by_sri, by_entity, con, cc2mc2mn)
    return SimpleNamespace(**o, slug=o['ents'].set_index('entity')['slug'], o=o)


def test_real_corridors(built):
    c = built.o['road-corridors']
    slug = built.slug
    assert [(s, n, k, [slug[int(e)] for e in es.split(',')]) for s, n, k, es in c[['slug', 'name', 'kind', 'entities']].values] == [
        ('bergen/palisade-avenue', 'Palisade Avenue', 'sequential', ['bergen/englewood-cliffs/palisade-avenue', 'bergen/englewood/west-palisade-avenue', 'bergen/east-palisade-avenue']),
        ('bergen/palisades-park/central-boulevard', 'Central Boulevard', 'sequential', ['bergen/palisades-park/west-central-boulevard', 'bergen/palisades-park/east-central-boulevard']),
        # Tonnelle Ave and NJDOT's "US 1 SECONDARY" carriageway (~30 m apart): one right-of-way.
        ('hudson/tonnelle-avenue', 'Tonnelle Avenue', 'parallel', ['hudson/north-bergen/us-1-secondary', 'hudson/tonnelle-avenue']),
        ('nj/brunswick-pike', 'Brunswick Pike', 'sequential', ['middlesex/plainsboro/brunswick-pike', 'mercer/brunswick-pike']),
        ('nj/general-pulaski-skyway', 'General Pulaski Skyway', 'sequential', ['hudson/general-pulaski-skyway', 'essex/newark/general-pulaski-skyway']),
        ('nj/river-road', 'River Road', 'sequential', ['hudson/river-road', 'bergen/edgewater/river-road']),
        ('nj/us-highway-1', 'US Highway 1', 'sequential', ['union/elizabeth/us-highway-1-2', 'essex/newark/us-highway-1']),
        ('nj/us-highway-1-2', 'US Highway 1', 'sequential', ['union/rahway/us-highway-1', 'middlesex/us-highway-1']),
        ('union/linden/edgar-road', 'Edgar Road', 'sequential', ['union/linden/west-edgar-road', 'union/linden/east-edgar-road']),
    ]
    ents = built.ents.set_index('slug')
    # The secondary carriageway maps onto Tonnelle Ave's chain near its north end (North Bergen).
    assert [tuple(r(ents.loc[s, ['corridor_c0', 'corridor_sign', 'chain_mi']], 2)) for s in ('hudson/tonnelle-avenue', 'hudson/north-bergen/us-1-secondary')] == [
        # (its parent MPs 59.46–60.01; Tonnelle Ave's chain starts at MP 54.6)
        (0.0, 1.0, 6.05), (4.86, 1.0, 0.55),
    ]


def test_real_pieces_and_chain(built):
    p = built.o['road-pieces']
    p = p[p['entity'].map(built.slug).isin(['hudson/j-f-kennedy-boulevard', 'hudson/jersey-city/west-side-avenue'])]
    assert [(built.slug[e], s, lo, hi, int(d), round(c0, 3), round(c1, 3), j) for e, s, lo, hi, d, c0, c1, j in p[['entity', 'sri', 'mp_lo', 'mp_hi', 'dir', 'chain_lo', 'chain_hi', 'join']].values] == [
        # JFK Blvd: CR 690 (Bayonne), CR 501's Hudson span, then CR 693 (North Bergen) backwards.
        ('hudson/j-f-kennedy-boulevard', '09000690__', 0.0, 0.62, 1, 0.0, 0.62, 'start'),
        ('hudson/j-f-kennedy-boulevard', '00000501__', 23.81, 37.31, 1, 0.62, 14.12, 'contiguous'),
        ('hudson/j-f-kennedy-boulevard', '09000693__', 2.35, 2.64, -1, 14.12, 14.41, 'contiguous'),
        # West Side Ave: its 4 SRIs, across the ~350 m Journal Square gap.
        ('hudson/jersey-city/west-side-avenue', '09061684__', 0.0, 1.95, 1, 0.0, 1.95, 'start'),
        ('hudson/jersey-city/west-side-avenue', '09061575__', 0.0, 0.23, 1, 1.982, 2.212, 'contiguous'),
        ('hudson/jersey-city/west-side-avenue', '09061725__', 0.0, 0.73, 1, 2.212, 2.942, 'contiguous'),
        ('hudson/jersey-city/west-side-avenue', '09061374__', 0.0, 0.33, 1, 3.154, 3.484, 'gap'),
    ]
    # Every placed crash has a chain; unplaced ones don't.
    be = built.by_entity
    placed = be['mp'].notna().to_numpy()
    assert (be['chain'].notna().to_numpy() == placed).all()


def test_real_nodes_and_west_side_inclusive(built):
    n = built.o['road-nodes']
    assert n[['n_legs', 'n_roads', 'label', 'n_crashes']].values.tolist() == [
        [4, 2, 'Duncan Avenue & J F Kennedy Boulevard', 0],
        [4, 2, 'West Side Avenue & Duncan Avenue', 24],
        [3, 2, 'Bergen Avenue & J F Kennedy Boulevard', 0],
        [3, 2, 'Boulevard East & River Road & Anthony M DeFino Way', 0],
        [3, 2, 'Boulevard East & Highwood Terrace', 0],
        [3, 2, '38th Street & J F Kennedy Boulevard', 0],
        [4, 2, 'East Palisade Avenue & Grand Avenue & Engle Street', 0],
        [6, 1, 'River Road & Alexander Way', 0],
        [8, 2, 'Broad Avenue & East Central Boulevard & East Central Avenue', 0],
        [8, 2, 'Amboy Avenue & US Highway 1', 0],
    ]
    wsa = built.ents.set_index('slug').loc['hudson/jersey-city/west-side-avenue', 'entity']
    s = built.o['road-summary']
    s = s[s['entity'] == wsa].groupby('year')[['n', 'n_unplaced', 'n_node', 'n_xs']].sum()
    # 2019: 7 crashes at West Side & Duncan are on Duncan Ave; they count on West Side too (inclusive).
    assert s.reset_index().values.tolist() == [[2006, 107, 96, 2, 0], [2016, 126, 112, 7, 0], [2019, 172, 8, 8, 7]]
    xs = built.o['xs']
    assert sorted(set(zip(xs['entity'].map(built.slug), xs['own_entity'].map(built.slug)))) == [
        ('hudson/jersey-city/duncan-avenue', 'hudson/jersey-city/west-side-avenue'),
        ('hudson/jersey-city/west-side-avenue', 'hudson/jersey-city/duncan-avenue'),
    ]


def test_real_blocks_match_crash_rows(built):
    """`road-blocks` counts are exactly the crash rows grouped by their `block` column, and that column
    is reproducible from the stored float32 values alone (specs/road-model-v5.md § v5.1): a row's
    position is its node's `road-node-entities.chain` when it's at a node, else its `chain`; its block
    is the entity's last block with `chain_lo` ≤ that (the first block when below all)."""
    blocks, be, xs = built.o['road-blocks'], built.by_entity, built.o['xs']
    keys = blocks[['entity', 'block']].astype('int64')

    def grouped(df):
        d = df[df['block'].notna().to_numpy()]
        g = d.groupby([d['entity'].astype('int64'), d['block'].astype('int64')]).size()
        return keys.merge(g.rename('n').reset_index(), on=['entity', 'block'], how='left')['n'].fillna(0).astype(int).tolist()

    assert blocks['n_crashes'].tolist() == grouped(be)
    assert blocks['n_crashes_xs'].tolist() == grouped(xs)
    # Every placed row has a block, unplaced ones none; xs rows have one where the node has a chain.
    assert (be['block'].notna() == be['chain'].notna()).all()
    assert (xs['block'].notna() == xs['chain'].notna()).all()
    assert int(blocks['n_crashes'].sum()) == int(be['chain'].notna().sum())
    # The frontend's rule, on the written (float32) values.
    ne = built.o['road-node-entities'].set_index(['entity', 'node'])['chain']
    lo = {e: g['chain_lo'].to_numpy(dtype='float32') for e, g in blocks.groupby('entity')}

    def fe_block(e, pos):
        i = int(np.searchsorted(lo[e], np.float32(pos), side='right')) - 1
        return max(i, 0)

    for df in (be, xs):
        placed = df[df['chain'].notna().to_numpy()]
        pos = [
            ne.get((int(e), int(n)), c) if not pd.isna(n) else c
            for e, n, c in zip(placed['entity'], placed['node'], placed['chain'].astype('float32'))
        ]
        assert [fe_block(int(e), p) for e, p in zip(placed['entity'], pos)] == placed['block'].astype(int).tolist()
    # West Side Ave (the fixture has one node on it, Duncan Ave): the block before the Journal
    # Square gap ends at its piece's end, and the next starts after the gap (v5: one block across it).
    wsa = built.ents.set_index('slug').loc['hudson/jersey-city/west-side-avenue', 'entity']
    w = blocks[blocks['entity'] == wsa]
    assert [tuple(r(x, 3)) + (None if pd.isna(a) else 'node', None if pd.isna(z) else 'node') for x, a, z in zip(w[['chain_lo', 'chain_hi']].values.tolist(), w['node_lo'], w['node_hi'])] == [
        (0.0, 1.956, None, 'node'),
        (1.956, 2.942, 'node', None),
        (3.154, 3.484, None, None),
    ]


def test_block_stats_and_xs_counts():
    blocks = pd.DataFrame({'entity': [0, 0], 'block': [0, 1], 'chain_lo': [0.0, 0.5], 'chain_hi': [0.5, 1.0]}).astype({'entity': 'int32', 'block': 'int32', 'chain_lo': 'float32', 'chain_hi': 'float32'})
    be = pd.DataFrame({'entity': [0, 0, 0, 0], 'block': pd.array([0, 1, 1, pd.NA], dtype='Int32'), 'severity': ['f', 'i', 'p', 'p'], 'tk': [1, 0, 0, 0]})
    xs = pd.DataFrame({'entity': [0], 'block': pd.array([1], dtype='Int32'), 'severity': ['i'], 'tk': [0]})
    out = block_stats(blocks, be, xs)
    assert out.drop(columns=['chain_lo', 'chain_hi']).values.tolist() == [
        [0, 0, 1, 1, 0, 1, 0, 0, 0, 0],
        [0, 1, 2, 0, 1, 0, 1, 0, 1, 0],
    ]
    assert out.columns.tolist() == [
        'entity', 'block', 'chain_lo', 'chain_hi', 'n_crashes', 'n_fatal', 'n_injury', 'n_killed',
        'n_crashes_xs', 'n_fatal_xs', 'n_injury_xs', 'n_killed_xs',
    ]


def test_corridor_only_rows():
    """A road name several entities carry ("48TH ST": East / West 48th Street) → the crash goes on
    their corridor, on a representative member: the one its cross street's intersection is on
    (then it's that side, not corridor-only), else the one in its muni, else the spine."""
    corridors = pd.DataFrame({'corridor': [0], 'spine': [11]})
    corridor_of = {10: 0, 11: 0}
    ents = pd.DataFrame({'entity': [10, 11, 12], 'cc': [9, 9, 9], 'mc': pd.array([1, 1, 2], dtype='Int16')})
    pieces = pd.DataFrame({'entity': [10, 11, 12], 'chain_hi': [0.15, 0.6, 1.0]})
    by_entity = pd.DataFrame({
        'entity': pd.Series([], dtype='int32'), 'id': pd.Series([], dtype='Int64'), 'cc': pd.Series([], dtype='Int8'),
        'mc': pd.Series([], dtype='float64'), 'road': pd.Series([], dtype='string'), 'sri': pd.Series([], dtype='string'),
        'mp': pd.Series([], dtype='float32'), 'chain': pd.Series([], dtype='float64'), 'lat': pd.Series([], dtype='float64'),
        'lon': pd.Series([], dtype='float64'), 'loc_source': pd.Series([], dtype='string'), 'corridor_only': pd.Series([], dtype='bool'),
    })
    cands = pd.DataFrame({
        'id': [1, 2, 3, 4], 'cc': [9, 9, 9, 9], 'mc': [1.0, 2.0, 1.0, 1.0], 'road': ['48TH ST', '48TH ST', '48TH ST', 'MAIN ST'],
        'lat': [40.6, 40.6, 40.6, 40.6], 'lon': [-74.1] * 4, 'loc_source': ['none'] * 4,
        '_cands': [(10, 11), (10, 11), (10, 11), (10, 12)],
    })
    out = corridor_only_rows(cands, corridor_of, corridors, ents, pieces, by_entity, at_node={2: {10}})
    assert out[['id', 'entity', 'loc_source', 'corridor_only']].values.tolist() == [
        # muni 1: both candidates are in it; the spine
        [1, 11, 'name_only', True],
        # muni 2 has neither: the spine
        [2, 11, 'name_only', True],
        # its cross street meets only East (10): that side
        [3, 10, 'name_only', False],
        # (10, 12: no one corridor — dropped)
    ]
    assert out[['sri', 'mp', 'lat', 'lon', 'chain']].isna().all().all()
    assert out.dtypes.astype(str).to_dict() == by_entity.dtypes.astype(str).to_dict()


def test_locate_several_roads_named():
    """A name on several entities in the muni, no cross street → `none` with the candidates."""
    import shapely
    from njdot.loc_recovery import _locate_one
    lines = np.array([shapely.LineString([(0, 0), (100, 0)]), shapely.LineString([(200, 0), (300, 0)])])
    ctx = dict(
        lines=lines, segs_by={(9, 1, '48THST'): np.array([0, 1])}, segs_named={(9, 1, '48THST'): np.array([0, 1])}, segs_cc={},
        seg_ent=np.array([10.0, 11.0]), seg_sris=np.array([None, None], dtype=object), sri_lines={}, ent_sris={}, sri_ent={}, snapper=None,
    )
    assert _locate_one(9, 1, ('48THST',), None, pd.NA, pd.NA, 0.0, '', None, False, False, None, **ctx) == ('none', None, None, None, frozenset({10, 11}))
    one = dict(ctx, seg_ent=np.array([10.0, 10.0]))
    assert _locate_one(9, 1, ('48THST',), None, pd.NA, pd.NA, 0.0, '', None, False, False, None, **one) == ('name_only', None, None, None, 10)
