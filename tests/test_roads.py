from os.path import dirname, join
from types import SimpleNamespace

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pytest

from njdot.cc2mc2mn import cc2mc2mn
from njdot.cli.roads import (
    alias_candidates, assign_crashes, build_geom, crashes_by_sri, entity_table, point_aliases, point_names,
    road_names_index, road_outputs, road_runs, smooth_names, sri_hit, sris, stretch_aliases,
)
from njdot.road_net import (
    merge_key, name_key, name_points, ng_intervals, ng_segments, rn_features, rn_points, road_entities, shield,
)


def crash(i, sri, mp, dt, severity='p', tk=0):
    return {
        'sri': sri, 'mp': mp, 'id': i, 'year': 2020, 'dt': pd.Timestamp(dt), 'cc': 9, 'mc': 6, 'case': f'c{i}',
        'severity': severity, 'tk': tk, 'ti': 0, 'pk': 0, 'pi': 0, 'tv': 1, 'road': 'RT 1', 'cross_street': 'X',
        'route': 1,
    }


def na(xs):
    return [None if pd.isna(x) else x for x in xs]


def test_crashes_by_sri_filters_joins_and_sorts():
    crashes = pd.DataFrame([
        crash(1, 'B', 2.0, '2020-01-02'),
        crash(2, '', 1.0, '2020-01-01'),  # empty SRI → dropped
        crash(3, 'A', 5.0, '2020-01-03'),
        crash(4, None, 1.0, '2020-01-01'),  # null SRI → dropped
        crash(5, 'A', 1.5, '2020-01-04'),
        crash(6, 'B', 2.0, '2020-01-01'),  # same (sri, mp) as 1, earlier dt → first
    ], index=[10, 11, 12, 13, 14, 15])
    # Per-table years have int `route`, AASHTO years str: mixed after the concat.
    crashes['route'] = crashes['route'].astype(object)
    crashes.loc[12, 'route'] = '9'
    # `_build_base` output: only geocoded rows (15 is ungeocoded → lat/lon NaN, kept).
    latlon = pd.DataFrame({'lat': [40.1, 40.3, 40.5], 'lon': [-74.1, -74.3, -74.5]}, index=[10, 12, 14])
    out = crashes_by_sri(crashes, latlon)
    assert out[['sri', 'mp', 'id']].values.tolist() == [['A', 1.5, 5], ['A', 5.0, 3], ['B', 2.0, 6], ['B', 2.0, 1]]
    assert out['lat'].tolist()[:2] == [40.5, 40.3]
    assert out['lat'].isna().tolist() == [False, False, True, False]
    assert out['route'].tolist() == ['1', '9', '1', '1']
    assert pa.Table.from_pandas(out, preserve_index=False).schema.field('route').type == pa.string()


def test_shield():
    assert [shield(*s) for s in [
        ('COR', 'M', '501'), ('USR', 'M', '1'), ('USR', 'T', '1'), ('STR', 'N', '139'), ('INT', 'M', '78'),
        ('TPK', 'M', None), ('N', 'N', None), (None, None, None),
    ]] == ['CR 501', 'US 1', 'US 1 Truck', 'NJ 139', 'I-78', 'NJ Turnpike', None, None]


def test_name_key():
    assert name_key(pd.Series(['W Side Ave', 'Westside Ave', 'WEST SIDE AVENUE', 'N Arlington Ave'])).tolist() == [
        'WESTSIDEAVE', 'WESTSIDEAVE', 'WESTSIDEAVE', 'NORTHARLINGTONAVE',
    ]


def test_merge_key():
    assert merge_key(pd.Series([
        'Tonnele Avenue', 'Tonnelle Avenue', 'JOHN F KENNEDY BLVD E', 'J F Kennedy Boulevard East',
        'MARTIN LUTHER KING JR DR', 'Martin Luther King Drive', 'Saint Pauls Avenue', 'ST PAULS AVE',
        'Luis Muñoz Marin Blvd',
    ])).tolist() == [
        'TONELEAVE', 'TONELEAVE', 'JFKENEDYBLVDEAST', 'JFKENEDYBLVDEAST',
        'MARTINLUTHERKINGDR', 'MARTINLUTHERKINGDR', 'STPAULSAVE', 'STPAULSAVE',
        'LUISMUNOZMARINBLVD',
    ]


def test_alias_candidates():
    road = pd.Series([
        'US 1 (Tonnelle Avenue)', 'US 1', 'RT 1`', 'I-78 EB', 'DUNCAN AVE / W SIDE AVE', 'W SIDE AVE **',
        None, 'Kennedy Blvd & Sip Ave', 'NJ 440 (Route 440 Connector)', 'I-95 N J TPKE-W ALIGNMENT',
        'NJ 495 SECONDARY', 'HUDSON COUNTY 677 II', 'NJ 139 LOWER', 'CR 677II', 'HUDSON COUNTY 677 2',
        'HUDSON COUNTY 677 IV',
    ])
    out = alias_candidates(road)
    assert list(zip(out.index, out)) == [
        (0, 'TONNELLE AVE'), (5, 'W SIDE AVE'), (8, 'RT 440 CONNECTOR'),
    ]


# Synthetic lines along 40.70°N: 0.1 mi ≈ 0.001904° of longitude there.
DLON = 0.001904
LAT = 40.70


def rn_row(sri, ms, me, lon0, n_pts=3, parent=None, ps=None, pe=None, subt=7, name='A ST', m=None):
    lons = list(np.linspace(lon0, lon0 + (me - ms) * 10 * DLON, n_pts))
    return {
        'SRI': sri, 'MP_START': ms, 'MP_END': me, 'SLD_NAME': name, 'PARENT_SRI': parent or sri,
        'PARENT_MP_START': ps if ps is not None else ms, 'PARENT_MP_END': pe if pe is not None else me,
        'ROUTE_SUBTYPE': subt, 'x': lons, 'y': [LAT] * n_pts,
        'm': m if m is not None else list(np.linspace(ms, me, n_pts)),
    }


def test_rn_points_primary_and_secondary_parent_mp():
    rn = pd.DataFrame([
        rn_row('A', 0.0, 0.12, -74.0),
        # A divided stretch: `A_S` is measured 0–0.1 locally, reported on the parent's MP 0.1 → 0.0.
        rn_row('A_S', 0.0, 0.1, -74.0 + 0.1 * DLON * 10, parent='A', ps=0.1, pe=0.0, subt=7),
    ])
    pts = rn_points(rn_features(rn))
    assert pts[['sri', 'mp']].values.tolist() == [
        ['A', 0.0], ['A', 0.05], ['A', 0.1], ['A', 0.12],
        ['A_S', 0.0], ['A_S', 0.05], ['A_S', 0.1],
    ]
    # `A_S` runs west→east in local measure, so parent MP 0.1 is its west end.
    lon0 = -74.0 + DLON
    assert np.round(pts['lon'].to_numpy() - np.r_[[-74.0] * 4, [lon0] * 3], 6).tolist() == [
        0.0, round(0.5 * DLON, 6), round(DLON, 6), round(1.2 * DLON, 6),
        round(DLON, 6), round(0.5 * DLON, 6), 0.0,
    ]


def test_rn_features_falls_back_to_distance_when_m_is_bad():
    rn = pd.DataFrame([rn_row('A', 0.0, 0.2, -74.0, n_pts=3, m=[0.0, None, 0.2]), rn_row('B', 0.0, 0.2, -74.1, n_pts=3, m=[0.0, 0.15, 0.1])])
    assert [np.round(m, 3).tolist() for m in rn_features(rn)['m']] == [[0.0, 0.1, 0.2], [0.0, 0.1, 0.2]]


def ng_row(name, lons, lats, sri=None, rcl=None, cc=9, muni='Jersey City', shld=('N', 'N', None)):
    return {
        'RCL_NGUID': rcl or name, 'PRIMENAME': name, 'SRI': sri, 'cc_l': cc, 'cc_r': cc, 'muni_l': muni, 'muni_r': muni,
        'SHLD_TYPE': shld[0], 'SHLDSUBTYP': shld[1], 'SHLD_NUM': shld[2], 'x': lons, 'y': lats,
    }


def test_ng_intervals_tag_check_and_snap():
    feats = rn_features(pd.DataFrame([rn_row('A', 0.0, 0.4, -74.0, n_pts=5)]))
    x = lambda mp: -74.0 + mp * 10 * DLON
    seg = ng_segments(pd.DataFrame([
        ng_row('First St', [x(0.0), x(0.1)], [LAT, LAT], sri='A'),  # tagged, on the line → [0, 0.1]
        ng_row('Far St', [x(0.1), x(0.2)], [LAT + 0.01, LAT + 0.01], sri='A'),  # tagged, ~1.1 km off → rejected
        ng_row('Cross St', [x(0.2), x(0.2)], [LAT, LAT + 0.003], sri='A'),  # tagged, perpendicular → rejected
        ng_row('Second St', [x(0.2), x(0.35)], [LAT + 0.00003, LAT + 0.00003], sri=None),  # untagged, 3 m off → snapped
        ng_row('Stub', [x(0.35), x(0.36)], [LAT, LAT], sri=None),  # untagged, < SNAP_MIN_LEN_M → not snapped
    ]))
    iv = ng_intervals(seg, feats)
    assert [(seg['name'][r.seg], r.sri, r.src, round(r.mp_lo, 2), round(r.mp_hi, 2)) for r in iv.itertuples()] == [
        ('First St', 'A', 'tag', 0.0, 0.1),
        ('Second St', 'A', 'snap', 0.2, 0.35),
    ]


def test_name_points_most_inside_interval_and_fallbacks():
    geom = pd.DataFrame({
        'sri': ['09000001__'] * 5 + ['00000002__'] * 2,
        'mp': [0.0, 0.05, 0.1, 0.15, 0.3, 0.0, 0.05],
        'sld_name': ['SLD A'] * 5 + ['SLD B'] * 2,
    })
    seg = pd.DataFrame({'name': ['West Side Avenue', 'Duncan Avenue', None], 'cc': pd.array([9, 9, 9], dtype='Int8'), 'muni': ['Jersey City'] * 3})
    iv = pd.DataFrame({
        'sri': ['09000001__', '09000001__', '09000001__'],
        'mp_lo': [0.0, 0.08, 0.0], 'mp_hi': [0.08, 0.16, 0.3], 'seg': [0, 1, 2],
    })
    out = name_points(geom, iv, seg, duckdb.connect())
    # MP 0.1 is inside both named intervals' ε-margins; it's deeper inside Duncan's. The unnamed
    # interval (seg 2) names nothing: MP 0.3 keeps its SLD name. SRI `00000002__` has no NG911
    # coverage and no county prefix → cc null.
    assert out[['name', 'seg']].values.tolist() == [
        ['West Side Avenue', 0], ['West Side Avenue', 0], ['Duncan Avenue', 1], ['Duncan Avenue', 1], ['SLD A', -1],
        ['SLD B', -1], ['SLD B', -1],
    ]
    assert na(out['cc']) == [9, 9, 9, 9, 9, None, None]


def test_smooth_names_absorbs_blips():
    J, K = 'J F Kennedy Boulevard', 'Kennedy Boulevard'
    names = (
        [('X', 'W Side Ave'), ('X', 'Cator Ave'), ('X', 'Cator Ave'), ('X', 'Oops St'), ('X', 'Cator Ave')]
        + [('Y', 'Solo St')]
        # Alternating blips resolve smallest-first: the lone K, then the 2-point K.
        + [('Z', n) for n in [J, J, J, K, K, J, J, K, J, J, J]]
    )
    df = pd.DataFrame({'sri': [s for s, _ in names], 'mp': [0.05 * i for i in range(len(names))], 'name': [n for _, n in names]})
    assert smooth_names(df)['name'].tolist() == ['Cator Ave'] * 5 + ['Solo St'] + [J] * 11


def test_smooth_names_county_blip():
    df = pd.DataFrame({'sri': ['A'] * 5, 'mp': [0.0, 0.05, 0.1, 0.15, 0.2], 'name': ['US Highway 1'] * 5, 'cc': pd.array([20, 20, 7, 20, 20], dtype='Int8')})
    assert smooth_names(df)['cc'].tolist() == [20] * 5


# West Side Ave, Jersey City in miniature: SRI `WSA1` is "W Side Ave" for MP 0–0.2 then turns onto
# "Duncan Ave"; SRI `WSA2` continues "W Side Ave" north from WSA1's MP 0.2 point; `FAR` is another
# "W Side Ave" ~11 km away. ~163 m per tenth (0.00147° lat).
D = 0.00147


def wsa_geom():
    pts = [
        ('WSA1', 0.0, 'W Side Ave', -74.07, 40.70),
        ('WSA1', 0.1, 'W Side Ave', -74.07, 40.70 + D),
        ('WSA1', 0.2, 'W Side Ave', -74.07, 40.70 + 2 * D),
        ('WSA1', 0.3, 'Duncan Ave', -74.07 + 0.0019, 40.70 + 2 * D),
        ('WSA1', 0.4, 'Duncan Ave', -74.07 + 0.0038, 40.70 + 2 * D),
        ('WSA2', 0.0, 'W Side Ave', -74.07, 40.70 + 2 * D + 0.0002),  # ~22 m from WSA1's MP 0.2
        ('WSA2', 0.1, 'W Side Ave', -74.07, 40.70 + 3 * D),
        ('FAR', 0.0, 'W Side Ave', -74.07, 40.80),
        ('FAR', 0.1, 'W Side Ave', -74.07, 40.80 + D),
    ]
    df = pd.DataFrame([
        {'sri': s, 'mp': mp, 'sld_name': 'WEST SIDE AVE', 'name': n, 'subt': np.int8(6), 'lon': lon, 'lat': lat}
        for s, mp, n, lon, lat in pts
    ])
    return df.sort_values(['sri', 'mp'], kind='stable').reset_index(drop=True)


def test_road_runs_split_on_name():
    runs, point_run = road_runs(wsa_geom())
    assert runs[['sri', 'name', 'mp_lo', 'mp_hi', 'mp_end']].values.tolist() == [
        ['FAR', 'W Side Ave', 0.0, 0.1, 0.2],
        ['WSA1', 'W Side Ave', 0.0, 0.2, 0.3],
        ['WSA1', 'Duncan Ave', 0.3, 0.4, 0.5],
        ['WSA2', 'W Side Ave', 0.0, 0.1, 0.2],
    ]
    assert point_run.tolist() == [0, 0, 1, 1, 1, 2, 2, 3, 3]


def test_road_runs_tail_capped_at_mp_gap():
    geom = pd.DataFrame({
        'sri': ['A'] * 4, 'mp': [0.0, 0.05, 5.0, 5.05], 'sld_name': ['A'] * 4, 'name': ['King Georges Post Road'] * 2 + ['J F Kennedy Boulevard'] * 2,
        'subt': np.int8(5), 'lon': [-74.0, -74.001, -74.1, -74.101], 'lat': [40.7] * 4,
    })
    runs, _ = road_runs(geom)
    assert runs[['name', 'mp_lo', 'mp_hi', 'mp_end']].values.tolist() == [
        ['King Georges Post Road', 0.0, 0.05, 0.15],
        ['J F Kennedy Boulevard', 5.0, 5.05, 5.15],
    ]


def test_road_entities_join_touching_same_name_across_sris():
    geom = wsa_geom()
    runs, point_run = road_runs(geom)
    # FAR (sri 'FAR' sorts first) → 0; WSA1's W Side Ave + WSA2 → 1; Duncan Ave → 2.
    assert road_entities(runs, geom, point_run).tolist() == [0, 1, 2, 1]


def test_road_entities_alias_rules():
    """Touching runs join when one's *name* is the other's name or major local alias; sharing only an
    alias isn't enough (JFK Blvd vs Boulevard East, both aliased "J F Kennedy Boulevard East" where
    they meet); nor is a minor alias (one Duncan Ave junction segment aliased "Bergen Avenue");
    nor a county line."""
    # 3-point runs end to end along 40.70°N, points ~50 m apart (touching); the last across a county line.
    names = ['J F Kennedy Boulevard', 'Kennedy Boulevard', 'Boulevard East', 'Duncan Avenue', 'Bergen Avenue', 'Bergen Avenue']
    rows = []
    for r, name in enumerate(names):
        for k in range(3):
            rows.append({'sri': f'S{r}', 'mp': 0.05 * k, 'sld_name': 'X', 'name': name, 'subt': np.int8(7),
                         'lon': -74.0 + (3 * r + k) * 0.0006, 'lat': LAT, 'cc': 9 if r < 5 else 2})
    geom = pd.DataFrame(rows)
    geom['cc'] = geom['cc'].astype('Int8')
    runs, point_run = road_runs(geom)
    names_df = pd.DataFrame([
        (0, 'L', 'Kennedy Boulevard', 3),  # JFK's major alias: joins run 1
        (0, 'L', 'J F Kennedy Boulevard East', 3),
        (2, 'L', 'J F Kennedy Boulevard East', 3),  # shared alias only: no join with 0 / 1
        (3, 'L', 'Bergen Avenue', 1),  # 1 of 3 points: minor → no join with 4
    ], columns=['run', 'kind', 'value', 'n'])
    assert road_entities(runs, geom, point_run, names_df).tolist() == [0, 0, 1, 2, 3, 4]
    names_df.loc[3, 'n'] = 3  # now a major alias → Duncan joins Bergen (same county only)
    assert road_entities(runs, geom, point_run, names_df).tolist() == [0, 0, 1, 2, 2, 3]


def wsa_runs():
    geom = wsa_geom()
    runs, point_run = road_runs(geom)
    runs['entity'] = road_entities(runs, geom, point_run)
    return geom, runs, point_run


def test_assign_crashes_uses_run_intervals():
    _, runs, _ = wsa_runs()
    by_sri = pd.DataFrame([
        crash(1, 'WSA1', 0.25, '2020-01-01'),  # [0.0, 0.3) → W Side Ave
        crash(2, 'WSA1', 0.30, '2020-01-02'),  # [0.3, 0.5) → Duncan Ave
        crash(3, 'WSA2', 0.05, '2020-01-03'),  # W Side Ave (via WSA2)
        crash(4, 'WSA1', 9.00, '2020-01-04'),  # past every run → on no entity
    ])
    out = assign_crashes(by_sri, runs, duckdb.connect())
    assert out[['entity', 'run', 'id']].values.tolist() == [[1, 1, 1], [1, 3, 3], [2, 2, 2]]


def test_point_aliases_per_run_and_bin():
    geom, runs, point_run = wsa_runs()
    by_entity = assign_crashes(pd.DataFrame(
        [crash(i, 'WSA1', 0.1, '2020-01-01') | {'road': 'WEST SIDE AVENUE'} for i in range(3)]  # == name, abbreviated
        + [crash(10 + i, 'WSA1', 0.1, '2020-01-01') | {'road': 'Route 440 connector'} for i in range(4)]
        + [crash(20 + i, 'WSA1', 0.35, '2020-01-01') | {'road': 'duncan  ave.'} for i in range(3)]  # == name
    ), runs, duckdb.connect())
    out = point_aliases(geom, point_run, stretch_aliases(geom, point_run, by_entity))
    # W Side Ave run (WSA1 MP 0–0.2): "RT 440 CONNECTOR" (4 of 7: dominant) beats the name itself
    # (3); Duncan Ave's only report is its own name → none; other SRIs have no reports.
    assert na(out) == [None, None, 'RT 440 CONNECTOR', 'RT 440 CONNECTOR', 'RT 440 CONNECTOR', None, None, None, None]


def test_stretch_aliases_dominant_only():
    """A stretch's alias must be its dominant crash-reported name: a cross street reported as the
    `road` on a minority of a stretch's crashes ("PARK AVE" on Boulevard East) isn't one."""
    geom, runs, point_run = wsa_runs()
    geom['seg'] = [-1, -1, -1, -1, -1, 7, 7, 7, 7]  # rows: FAR ×2, WSA1 ×5, WSA2 ×2; Duncan + WSA2 NG911-named
    by_entity = assign_crashes(pd.DataFrame(
        [crash(i, 'WSA1', 0.1, '2020-01-01') | {'road': 'HUDSON BLVD'} for i in range(4)]
        + [crash(10 + i, 'WSA1', 0.1, '2020-01-01') | {'road': 'PARK AVE'} for i in range(3)]
        + [crash(20 + i, 'WSA2', 0.05, '2020-01-01') | {'road': 'PARK AVE'} for i in range(3)]
        + [crash(30 + i, 'WSA2', 0.05, '2020-01-01') | {'road': w} for i, w in enumerate(['W SIDE AVE', 'W SIDE AVE', 'W SIDE AVE', 'SIP AVE'])]
    ), runs, duckdb.connect())
    out = stretch_aliases(geom, point_run, by_entity)
    # WSA1 bin 0 (run 1): "HUDSON BLVD" 4 of 7 → dominant; its points are mostly un-named. WSA2 bin 0
    # (run 3): "W SIDE AVE" 3 of 7 isn't a majority → no alias ("PARK AVE", 3, neither).
    assert out.values.tolist() == [[1, 0.0, 'HUDSON BLVD', 4, False]]


def test_entity_table_crash_aliases_only_on_unnamed_stretches():
    geom, runs, point_run = wsa_runs()
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    crashes = (
        [crash(i, 'WSA1', 0.1, '2020-01-01') | {'road': 'HUDSON BLVD'} for i in range(4)]
        + [crash(10 + i, 'FAR', 0.05, '2020-01-01') | {'road': 'OLD FAR RD'} for i in range(3)]
    )
    by_entity = assign_crashes(pd.DataFrame(crashes), runs, duckdb.connect())
    aliases = lambda seg: entity_table(runs, geom.assign(seg=seg), by_entity, duckdb.connect(), point_run=point_run)[0]['aliases'].tolist()
    # No NG911 names anywhere: both stretches' dominant crash names are aliases.
    assert na(aliases([-1] * 9)) == ['OLD FAR RD', 'HUDSON BLVD', None]
    # NG911 names FAR (and WSA2): FAR's crash string isn't an alias; WSA1's un-named stretch keeps its.
    assert na(aliases([7, 7, -1, -1, -1, -1, -1, 7, 7])) == [None, 'HUDSON BLVD', None]
    # NG911 names WSA1's W Side Ave stretch: its crash string isn't an alias; FAR's is.
    assert na(aliases([-1, -1, 7, 7, 7, -1, -1, -1, -1])) == ['OLD FAR RD', None, None]


def test_entity_table():
    geom, runs, point_run = wsa_runs()
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    by_entity = assign_crashes(pd.DataFrame([
        crash(1, 'WSA1', 0.1, '2020-01-01', severity='f', tk=1) | {'road': 'West Side Avenue'},
        crash(2, 'WSA2', 0.0, '2020-01-02', severity='i') | {'road': 'JFK BLVD'},
        crash(3, 'WSA1', 0.3, '2020-01-03') | {'road': 'Duncan Ave'},
        crash(4, 'WSA2', 0.0, '2020-01-04') | {'road': 'JFK Blvd.'},
        crash(5, 'WSA2', 0.0, '2020-01-05') | {'road': 'US 1 (JFK Boulevard)'},
        crash(6, 'WSA2', 0.0, '2020-01-06') | {'road': 'WESTSIDE AVE'},  # own name, spelled differently
        crash(7, 'WSA2', 0.0, '2020-01-07') | {'road': 'SIP AVE / W SIDE AVE'},  # intersection → dropped
        crash(8, 'WSA2', 0.0, '2020-01-08') | {'road': 'SIP AVE'},  # 1 of 7 < ALIAS_MIN_N
    ]), runs, duckdb.connect())
    out, searchable = entity_table(runs, geom, by_entity, duckdb.connect(), point_run=point_run)
    assert out.columns.tolist() == [
        'entity', 'name', 'route', 'subt', 'sris', 'lon_min', 'lat_min', 'lon_max', 'lat_max',
        'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases', 'cc', 'munis',
    ]
    assert out[['entity', 'name', 'route', 'sris', 'n_crashes', 'n_fatal', 'n_injury', 'n_killed', 'aliases']].astype(object).where(out.notna(), None).values.tolist() == [
        # `route`: no NG911 shield; the SLD name only stands in for route-class roads (`subt` ≤ 6),
        # and only where it differs from `name` after normalizing ("WEST SIDE AVE" == "W Side Ave").
        [0, 'W Side Ave', None, 'FAR', 0, 0, 0, 0, None],
        [1, 'W Side Ave', None, 'WSA1,WSA2', 7, 1, 1, 1, 'JFK BLVD'],
        [2, 'Duncan Ave', 'WEST SIDE AVE', 'WSA1', 1, 0, 0, 0, None],
    ]
    assert searchable.values.tolist() == [
        [0, 'primary', 'W Side Ave'], [1, 'primary', 'W Side Ave'], [2, 'primary', 'Duncan Ave'],
        [2, 'route', 'WEST SIDE AVE'], [1, 'alias', 'JFK BLVD'],
    ]


def test_road_names_index_span_scoped_rows():
    geom, runs, point_run = wsa_runs()
    geom['entity'] = runs['entity'].to_numpy()[point_run]
    ents, searchable = entity_table(runs, geom, assign_crashes(pd.DataFrame([crash(1, 'WSA1', 0.1, '2020-01-01')]), runs, duckdb.connect()), duckdb.connect())
    # An NG911 alias on WSA1's MP 0–0.2 points only (geom rows 2–4): its row gets that span's extent
    # (not the entity's, which continues up WSA2), and its middle point.
    pt_names = pd.DataFrame({'i': [2, 3, 4], 'kind': ['alias'] * 3, 'name_display': ['Hudson Blvd'] * 3})
    out = road_names_index(ents, searchable, geom, duckdb.connect(), pt_names)
    assert out.columns.tolist() == [
        'name_display', 'name_norm', 'kind', 'entity', 'cc', 'munis', 'subt', 'n_crashes', 'lon', 'lat',
        'lon_min', 'lat_min', 'lon_max', 'lat_max',
    ]
    assert out[['name_display', 'name_norm', 'kind', 'entity', 'n_crashes']].values.tolist() == [
        ['Duncan Ave', 'DUNCAN AVE', 'primary', 2, 0],
        ['Hudson Blvd', 'HUDSON BLVD', 'alias', 1, 1],
        ['W Side Ave', 'W SIDE AVE', 'primary', 0, 0],
        ['W Side Ave', 'W SIDE AVE', 'primary', 1, 1],
        ['WEST SIDE AVE', 'W SIDE AVE', 'route', 2, 0],
    ]
    hudson = out[out['name_norm'] == 'HUDSON BLVD'].iloc[0]
    assert [round(float(hudson[c]), 5) for c in ('lat_min', 'lat_max', 'lat')] == [40.70, round(40.70 + 2 * D, 5), round(40.70 + D, 5)]
    wsa = out[(out['entity'] == 1) & (out['kind'] == 'primary')].iloc[0]
    assert [round(float(wsa[c]), 5) for c in ('lat_min', 'lat_max')] == [40.70, round(40.70 + 3 * D, 5)]


def test_sri_hit_orders_by_s2_cell():
    geom = pd.DataFrame({
        'sri': ['A', 'A', 'A', 'B', 'B'], 'mp': [0.0, 0.1, 0.2, 0.0, 0.1],
        'lon': [-74.3, -74.25, -74.2, -74.01, -74.0], 'lat': [40.3, 40.25, 40.2, 40.01, 40.0],
    })
    # Level-16 S2 order: the two `B` points (SW, near 40.0°N) come first; within
    # the `A` cluster the curve visits MP 0.2 (40.2°N) before 0.0 / 0.1.
    out = sri_hit(geom)
    assert out[['sri', 'mp']].values.tolist() == [['B', 0.0], ['B', 0.1], ['A', 0.2], ['A', 0.0], ['A', 0.1]]


def test_sris_index():
    geom = pd.DataFrame({
        'sri': ['A', 'A', 'A', 'B', 'B'], 'mp': [0.0, 0.1, 0.2, 0.0, 0.1],
        'sld_name': ['A AVE', 'A AVENUE', 'A AVE', 'B ST', 'B ST'],
        'lon': [-74.3, -74.25, -74.2, -74.01, -74.0], 'lat': [40.3, 40.25, 40.2, 40.01, 40.0],
    })
    crashes = pd.DataFrame([
        crash(1, 'A', 0.1, '2020-01-01', severity='f', tk=2),
        crash(2, 'A', 0.2, '2020-01-02', severity='i'),
        crash(3, 'C', 0.2, '2020-01-02', severity='p'),  # SRI absent from geom → not indexed
    ])
    out = sris(geom, crashes)
    assert out.to_dict('records') == [
        {'sri': 'A', 'sld_name': 'A AVE', 'mp_min': 0.0, 'mp_max': 0.2, 'lon_min': -74.3, 'lat_min': 40.2,
         'lon_max': -74.2, 'lat_max': 40.3, 'n_crashes': 2, 'n_fatal': 1, 'n_injury': 1, 'n_killed': 2},
        {'sri': 'B', 'sld_name': 'B ST', 'mp_min': 0.0, 'mp_max': 0.1, 'lon_min': -74.01, 'lat_min': 40.0,
         'lon_max': -74.0, 'lat_max': 40.01, 'n_crashes': 0, 'n_fatal': 0, 'n_injury': 0, 'n_killed': 0},
    ]


# Real-data fixtures: statewide NJDOT Roadway Network lines + NG911 segments/aliases for a handful
# of SRIs (fetched 2026-09-26; vintages in each parquet's `src_*` metadata), via
#   njdot roads fetch-network -w "SRI IN (…)" -o tests/data/roads/roadway_network.parquet
#   njdot roads fetch-ng911   -w "SRI IN (…)" -o tests/data/roads/ng911
# with the SRIs: CR 501 (`00000501__`, `00000501_S`), CR 690/693 (`09000690__`, `09000693__`), CR 505 /
# Boulevard East (`00000505__`, `09111121__`, `09000677{2,3,4}_`), US 1 (`00000001__`, `00000001_S`), West
# Side Ave (Jersey City: `09061684__`, `09061725__`, `09061575__`, `09061374__`; North Bergen:
# `09081095__`, `09081122__`), Duncan / Bergen Aves (`09061521__`, `09061555__`, `09061686__`,
# `09061574__`, `09061709__`).
FIXTURES = join(dirname(__file__), 'data', 'roads')


@pytest.fixture(scope='module')
def real():
    con = duckdb.connect()
    b = build_geom(
        pd.read_parquet(join(FIXTURES, 'roadway_network.parquet')),
        pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet')),
        pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet')),
        con,
    )
    by_entity = assign_crashes(pd.DataFrame([crash(1, '00000501__', 30.0, '2020-01-01') | {'road': 'KENNEDY BLVD'}]), b['runs'], con)
    ents, searchable = entity_table(b['runs'], b['geom'], by_entity, con, b['names'], b['point_run'])
    idx = road_names_index(ents, searchable, b['geom'], con, point_names(b['geom'], b['seg'], b['aliases']))
    return SimpleNamespace(**b, ents=ents.set_index('entity', drop=False), idx=idx)


def entity_at(real, sri, mp):
    g = real.geom
    return int(g[(g['sri'] == sri) & (g['mp'] == mp)]['entity'].iloc[0])


def ent_runs(real, entity, sri=None):
    """`(sri, name, mp_lo, mp_end)` of `entity`'s runs (on `sri`)."""
    r = real.runs[(real.runs['entity'] == entity) & ((real.runs['sri'] == sri) if sri else True)]
    return [(s, n, round(lo, 2), round(end, 2)) for s, n, lo, end in r[['sri', 'name', 'mp_lo', 'mp_end']].values]


def index_rows(real, name_norm):
    """`(entity name, kind, munis)` of the search-index rows for `name_norm`."""
    x = real.idx[real.idx['name_norm'] == name_norm]
    return [(real.ents.at[e, 'name'], k, m) for e, k, m in x[['entity', 'kind', 'munis']].values]


def test_real_cr501_kennedy_blvd_is_hudson_span_only(real):
    jfk = entity_at(real, '00000501__', 30.0)
    e = real.ents.loc[jfk]
    assert (e['name'], e['route'], e['cc'], e['aliases'], e['sris']) == (
        'J F Kennedy Boulevard', 'CR 501 / CR 690 / CR 693', 9,
        'Kennedy Boulevard · Hudson Boulevard · Jfk Boulevard',
        '00000501_S,00000501__,09000690__,09000693__',
    )
    # CR 501's Hudson span (Bayonne → North Bergen), not the rest of the route.
    assert ent_runs(real, jfk, '00000501__') == [('00000501__', 'J F Kennedy Boulevard', 23.81, 37.31)]
    # South (Middlesex) and north (Bergen) of Hudson, CR 501 is other streets.
    assert [real.ents.at[entity_at(real, '00000501__', mp), 'name'] for mp in (2.0, 5.0, 40.0, 45.0, 50.0)] == [
        'New Durham Road', 'Amboy Avenue', 'East Central Boulevard', 'Engle Street', 'Piermont Road',
    ]
    # "Kennedy Blvd" / "JFK Blvd" / "Hudson Blvd" find only the Hudson entity; "CR 501" finds every stretch.
    for nn in ('KENNEDY BLVD', 'JFK BLVD', 'HUDSON BLVD'):
        assert index_rows(real, nn) == [('J F Kennedy Boulevard', 'alias', 'Jersey City · North Bergen Township · Bayonne · Union City · West New York')]
    assert sorted({n for n, _, _ in index_rows(real, 'CR 501')}) == [
        'Amboy Avenue', 'County Road', 'Dean Drive', 'East Central Boulevard', 'East Clinton Avenue', 'Engle Street',
        'Grand Avenue', 'Huyler Avenue', 'J F Kennedy Boulevard', 'King Georges Post Road', 'Middlesex Avenue',
        'New Durham Road', 'Piermont Road', 'West Central Boulevard', 'Westervelt Avenue',
    ]


def test_real_us1_tonnelle_ave_span(real):
    t = entity_at(real, '00000001__', 58.0)
    e = real.ents.loc[t]
    assert (e['name'], e['route'], e['munis']) == ('Tonnelle Avenue', 'US 1 / US 9', 'North Bergen Township · Jersey City')
    # "Tonnele" (NG911's variant spelling) and "Tonnelle" stretches are one road: Pulaski Skyway's end
    # to the Bergen line.
    assert ent_runs(real, t, '00000001__') == [
        ('00000001__', 'Tonnele Avenue', 54.7, 56.3), ('00000001__', 'Tonnelle Avenue', 56.3, 60.65),
    ]
    assert [real.ents.at[entity_at(real, '00000001__', mp), 'name'] for mp in (53.0, 62.0)] == ['General Pulaski Skyway', 'Broad Avenue']
    assert index_rows(real, 'TONNELLE AVE') == [('Tonnelle Avenue', 'primary', 'North Bergen Township · Jersey City')]
    assert index_rows(real, 'TONNELE AVE') == [('Tonnelle Avenue', 'alias', 'North Bergen Township · Jersey City')]


def test_real_west_side_ave_jersey_city_vs_north_bergen(real):
    jc, nb = entity_at(real, '09061684__', 1.0), entity_at(real, '09081095__', 1.0)
    assert [tuple(real.ents.loc[e, ['name', 'sris', 'munis']]) for e in (jc, nb)] == [
        ('West Side Avenue', '09061374__,09061575__,09061684__,09061725__', 'Jersey City'),
        ('West Side Avenue', '09081095__,09081122__', 'North Bergen Township'),
    ]
    assert index_rows(real, 'W SIDE AVE') == [
        ('West Side Avenue', 'primary', 'Jersey City'), ('West Side Avenue', 'primary', 'North Bergen Township'),
    ]


def test_real_west_side_ave_turns_into_duncan_ave_at_mp_1_95(real):
    g = real.geom[(real.geom['sri'] == '09061684__') & real.geom['mp'].between(1.85, 2.0)]
    assert g[['mp', 'name']].values.tolist() == [
        [1.85, 'West Side Avenue'], [1.9, 'West Side Avenue'], [1.95, 'Duncan Avenue'], [2.0, 'Duncan Avenue'],
    ]
    wsa, duncan = entity_at(real, '09061684__', 1.9), entity_at(real, '09061684__', 1.95)
    assert ent_runs(real, wsa, '09061684__') == [('09061684__', 'West Side Avenue', 0.0, 1.95)]
    assert ent_runs(real, duncan, '09061684__') == [('09061684__', 'Duncan Avenue', 1.95, 2.55)]
    assert real.ents.at[duncan, 'name'] == 'Duncan Avenue'


def test_real_park_ave_is_not_boulevard_east(real):
    """A 2-point "Park Avenue" junction run on `09111121__` carries the NG911 alias "Boulevard
    East"; that mustn't fuse Park Ave (Hoboken → Weehawken) into Boulevard East."""
    be, park = entity_at(real, '09000693__', 1.0), entity_at(real, '090006772_', 0.5)
    assert park != be
    assert ent_runs(real, park) == [
        ('090006772_', 'Park Avenue', 0.0, 1.32), ('090006773_', 'Park Avenue', 0.0, 0.2),
        ('090006774_', 'Park Avenue', 0.0, 0.2), ('09111121__', 'Park Avenue', 0.0, 0.1),
    ]
    assert ent_runs(real, be) == [
        ('00000505__', 'Boulevard East', 0.7, 1.95), ('09000693__', 'Boulevard East', 0.0, 2.35),
        ('09111121__', 'Boulevard East', 0.1, 1.02),
    ]


def test_real_boulevard_east_is_not_jfk_blvd(real):
    jfk, be = entity_at(real, '00000501__', 30.0), entity_at(real, '09000693__', 1.0)
    assert be != jfk
    # `09111121__`'s SLD name is "PARK AVE", but past MP 0.1 its line (and NG911) is Boulevard East.
    assert [entity_at(real, '09111121__', mp) for mp in (0.5, 0.9)] == [be, be]
    assert entity_at(real, '00000505__', 1.0) == be
    assert real.ents.at[be, 'aliases'] == 'J F Kennedy Boulevard East · Jfk Boulevard East · Kennedy Boulevard East'


@pytest.fixture(scope='module')
def real_out():
    con = duckdb.connect()
    b = build_geom(
        pd.read_parquet(join(FIXTURES, 'roadway_network.parquet')),
        pd.read_parquet(join(FIXTURES, 'ng911', 'centerlines.parquet')),
        pd.read_parquet(join(FIXTURES, 'ng911', 'aliases.parquet')),
        con,
    )
    by_sri = pd.DataFrame([
        crash(1, '00000501__', 30.0, '2020-01-01', severity='f', tk=1) | {'road': 'KENNEDY BLVD'},
        crash(2, '09061684__', 1.0, '2021-06-01', severity='i') | {'road': 'W SIDE AVE'},
        crash(3, '09061684__', 9.0, '2021-06-01'),  # past every run → no entity
    ])
    by_sri['_i'] = np.arange(len(by_sri))
    return road_outputs(b, by_sri, assign_crashes(by_sri, b['runs'], con), con, cc2mc2mn)


def test_real_slugs_and_renumbering(real_out):
    ents = real_out['ents']
    # Entity ids are slug ranks: `road-entities` is sorted by both.
    assert ents['entity'].tolist() == list(range(len(ents)))
    assert ents['slug'].tolist() == sorted(ents['slug'])
    hudson = ents[ents['slug'].str.startswith('hudson/')]
    assert [tuple(na(r)) for r in hudson[['slug', 'name', 'mc']].astype(object).values.tolist()] == [
        ('hudson/boulevard-east', 'Boulevard East', None),
        ('hudson/general-pulaski-skyway', 'General Pulaski Skyway', None),
        ('hudson/j-f-kennedy-boulevard', 'J F Kennedy Boulevard', None),
        ('hudson/jersey-city/bergen-avenue', 'Bergen Avenue', 6),
        ('hudson/jersey-city/duncan-avenue', 'Duncan Avenue', 6),
        ('hudson/jersey-city/sip-avenue', 'Sip Avenue', 6),
        ('hudson/jersey-city/west-side-avenue', 'West Side Avenue', 6),
        ('hudson/north-bergen/route-501-secondary', 'ROUTE 501 SECONDARY', 8),
        ('hudson/north-bergen/us-1-secondary', 'US 1 SECONDARY', 8),
        ('hudson/north-bergen/west-side-avenue', 'West Side Avenue', 8),
        ('hudson/park-avenue', 'Park Avenue', None),
        ('hudson/river-road', 'River Road', None),
        ('hudson/tonnelle-avenue', 'Tonnelle Avenue', None),
        ('hudson/union-city/38th-street', '38th Street', 10),
        ('hudson/union-city/park-avenue', 'Park Avenue', 10),
        ('hudson/weehawken/highwood-terrace', 'Highwood Terrace', 11),
    ]
    slug = ents.set_index('entity')['slug']
    # `crashes-by-sri` carries each crash's (renumbered) entity.
    assert str(real_out['by_sri']['entity'].dtype) == 'Int32'
    assert [None if pd.isna(e) else slug[e] for e in real_out['by_sri']['entity']] == [
        'hudson/j-f-kennedy-boulevard', 'hudson/jersey-city/west-side-avenue', None,
    ]
    assert [slug[e] for e in real_out['by_entity']['entity']] == ['hudson/j-f-kennedy-boulevard', 'hudson/jersey-city/west-side-avenue']
    assert [(slug[e], y, s, n) for e, y, s, n in real_out['road-summary'][['entity', 'year', 'severity', 'n']].values.tolist()] == [
        ('hudson/j-f-kennedy-boulevard', 2020, 'f', 1), ('hudson/jersey-city/west-side-avenue', 2020, 'i', 1),
    ]
    lengths = ents.set_index('slug')['length_mi'].astype('float64').round(2)
    assert lengths[['hudson/j-f-kennedy-boulevard', 'hudson/jersey-city/west-side-avenue', 'hudson/tonnelle-avenue']].tolist() == [14.11, 2.94, 6.05]


def test_real_search_tokens(real_out):
    s = real_out['road-search']
    k = s[s['token'] == 'kennedy']
    assert [tuple(na(r)) for r in k[['slug', 'matched', 'kind']].values.tolist()] == [
        ('hudson/j-f-kennedy-boulevard', None, 'primary'),
        ('hudson/j-f-kennedy-boulevard', 'J F Kennedy Boulevard East', 'alias'),
        ('hudson/j-f-kennedy-boulevard', 'J F Kennedy Boulevard West', 'alias'),
        ('hudson/j-f-kennedy-boulevard', 'Kennedy Boulevard', 'alias'),
        ('hudson/boulevard-east', 'East Kennedy Boulevard', 'alias'),
        ('hudson/boulevard-east', 'J F Kennedy Boulevard East', 'alias'),
        ('hudson/boulevard-east', 'Kennedy Boulevard East', 'alias'),
        ('hudson/park-avenue', 'Kennedy Boulevard East', 'alias'),
    ]
    assert s['token'].tolist() == sorted(s['token'])
