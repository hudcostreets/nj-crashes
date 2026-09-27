"""Curated overrides (`njdot.road_overrides`) and the anomaly audit (`njdot.road_anomalies`)."""
import numpy as np
import pandas as pd
import pytest

from njdot.road_anomalies import absorbed, corridor_yoy, pair_swings, review_queue, unplaced_share, yoy_breaks
from njdot.road_overrides import ROAD_OVERRIDES, apply_overrides, apply_recodes, load_overrides

ENTS = pd.DataFrame({
    'entity': [0, 1, 2], 'slug': ['hudson/jersey-city/garfield-avenue', 'hudson/jersey-city/broadway', 'hudson/bayonne/broadway'],
    'name': ['Garfield Avenue', 'Broadway', 'Broadway'], 'cc': [9, 9, 9],
})


def crash(entity, year, road, cross='', mc=6, src='name_only', sri=None, mp=None):
    return {'entity': entity, 'year': year, 'cc': 9, 'mc': mc, 'road': road, 'cross_street': cross, 'loc_source': src, 'sri': sri, 'mp': mp, 'severity': 'p'}


def write(tmp_path, text: str) -> str:
    p = tmp_path / 'overrides.yml'
    p.write_text(text)
    return str(p)


def test_load_overrides_validates(tmp_path):
    assert load_overrides(str(tmp_path / 'missing.yml')) == []
    # The repo's file parses.
    assert isinstance(load_overrides(ROAD_OVERRIDES), list)
    rule = "- id: a\n  note: x\n  where: {cc: 9}\n  set: {entity: null}\n"
    with pytest.raises(ValueError, match="duplicate override id 'a'"):
        load_overrides(write(tmp_path, rule + rule))
    with pytest.raises(ValueError, match="has no `note`"):
        load_overrides(write(tmp_path, "- id: a\n  where: {cc: 9}\n  set: {entity: null}\n"))
    with pytest.raises(ValueError, match=r"unknown `where` keys \['town'\]"):
        load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {town: 9}\n  set: {entity: null}\n"))
    with pytest.raises(ValueError, match='needs `set'):
        load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {cc: 9}\n"))


def test_apply_overrides(tmp_path):
    rules = load_overrides(write(tmp_path, """
- id: jc-broadway-greenville
  note: JC police called Garfield Ave "Broadway" (the SRI's name) south of Communipaw
  where:
    cc: 9
    mc: 6
    years: [2001, 2017]
    road: '(\\d+ )?BROADWAY( \\*+)?'
    cross_street: '.*(GATES|NEPTUNE|WINFIELD).*'
    entity: hudson/jersey-city/broadway
  set: {entity: hudson/jersey-city/garfield-avenue}
- id: drop-private
  note: test rule
  where: {road: '.*PARKING LOT.*'}
  set: {entity: null}
"""))
    be = pd.DataFrame([
        crash(1, 2010, 'BROADWAY', 'GATES AVE'),          # moved
        crash(1, 2010, '12 broadway **', 'Winfield Ave'),  # moved (case-insensitive, full match)
        crash(1, 2019, 'BROADWAY', 'GATES AVE'),          # outside the years
        crash(1, 2010, 'BROADWAY', 'JOURNAL SQ'),         # other cross street
        crash(2, 2010, 'BROADWAY', 'GATES AVE', mc=1),    # Bayonne
        crash(1, 2010, 'BROADWAY PARKING LOT', ''),       # dropped
    ])
    out, counts = apply_overrides(be, rules, ENTS)
    assert counts == {'jc-broadway-greenville': 2, 'drop-private': 1}
    assert [(e, y, r, None if pd.isna(o) else o) for e, y, r, o in out[['entity', 'year', 'road', 'override']].values] == [
        (0, 2010, 'BROADWAY', 'jc-broadway-greenville'),
        (0, 2010, '12 broadway **', 'jc-broadway-greenville'),
        (1, 2019, 'BROADWAY', None),
        (1, 2010, 'BROADWAY', None),
        (2, 2010, 'BROADWAY', None),
    ]
    bad = load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {cc: 9}\n  set: {entity: nowhere/road}\n"))
    with pytest.raises(ValueError, match="no entity with slug 'nowhere/road'"):
        apply_overrides(be, bad, ENTS)


def summary(rows: list[tuple]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=['entity', 'year', 'severity', 'n', 'n_unplaced'])


def test_yoy_breaks_dip_scaled_by_county():
    """Road 0 dips in 2011–2013 while its county doesn't; road 1 follows its county's 2020 drop
    (not flagged)."""
    rows = []
    for y in range(2005, 2020):
        rows.append((0, y, 'p', 10 if 2011 <= y <= 2013 else 100, 0))
        rows.append((1, y, 'p', 50 if y == 2016 else 100, 0))
        rows.append((2, y, 'p', 1000 if y != 2016 else 500, 0))  # the county's own dip in 2016
    q = yoy_breaks(summary(rows), ENTS)
    assert q[['slug', 'years', 'observed', 'expected', 'detail']].values.tolist() == [
        ['hudson/jersey-city/garfield-avenue', '2011-2013', '10 10 10', '100 100 100', 'dip'],
    ]


def test_unplaced_share_and_queue():
    s = summary([(0, 2010, 'p', 200, 90), (1, 2010, 'p', 200, 20), (2, 2010, 'p', 50, 40)])
    u = unplaced_share(s, ENTS)
    assert u[['slug', 'observed', 'expected', 'detail']].values.tolist() == [['hudson/jersey-city/garfield-avenue', '90', '200', '45% of crashes without a map point']]
    q = review_queue([u, pd.DataFrame()])
    assert q[['rank', 'kind', 'slug', 'score']].values.tolist() == [[1, 'unplaced', 'hudson/jersey-city/garfield-avenue', 40.5]]


def test_pair_swings():
    """Crashes at node 7 (roads 0 and 1): all on road 0 in 2010, all on road 1 in 2012."""
    be = pd.DataFrame({
        'entity': [0] * 30 + [1] * 30 + [0] * 15 + [1] * 15,
        'node': [7] * 90,
        'year': [2010] * 30 + [2012] * 30 + [2011] * 30,
    })
    ne = pd.DataFrame({'node': [7, 7], 'entity': [0, 1]})
    p = pair_swings(be, ne, ENTS)
    assert p[['slug', 'other_slug', 'years', 'observed', 'expected', 'score']].values.tolist() == [
        ['hudson/jersey-city/garfield-avenue', 'hudson/jersey-city/broadway', '2012 / 2010', '0% / 100%', '50%', 60.0],
    ]


def test_corridor_yoy_absorbs_member_swings():
    """Roads 0 and 1 are one corridor (7): in 2016 90 of road 0's crashes move to road 1 (a
    carriageway recoded to its express lanes), so each road has a `yoy` break but the corridor
    doesn't: both are absorbed. Road 2 (no corridor) keeps its break; so does road 0's in a year its
    corridor also breaks (2012)."""
    rows = []
    for y in range(2005, 2020):
        a, b = (10, 140) if y == 2016 else (100, 50)
        if y == 2012:
            a = 10
        rows += [(0, y, 'p', a, 0), (1, y, 'p', b, 0), (2, y, 'p', 10 if y == 2010 else 100, 0), (3, y, 'p', 1000, 0)]
    ents = pd.concat([ENTS, pd.DataFrame({'entity': [3], 'slug': ['hudson/other'], 'name': ['Other'], 'cc': [9]})], ignore_index=True)
    s = summary(rows)
    yoy = yoy_breaks(s, ents)
    members = pd.DataFrame({'entity': [0, 1], 'corridor': [7, 7]})
    cs = s[s['entity'].isin([0, 1])].assign(corridor=7).groupby(['corridor', 'year', 'severity'])['n'].sum().reset_index()
    cor = corridor_yoy(cs, pd.DataFrame({'corridor': [7], 'slug': ['hudson/garfield'], 'name': ['Garfield'], 'cc': [9]}), s, ents)
    assert cor[['kind', 'corridor', 'slug', 'years', 'observed', 'detail']].values.tolist() == [
        ['corridor_yoy', 7, 'hudson/garfield', '2012', '60', 'dip'],
    ]
    assert [(sl, y, d, bool(ab)) for sl, y, d, ab in zip(yoy['slug'], yoy['years'], yoy['detail'], absorbed(yoy, cor, members))] == [
        ('hudson/jersey-city/garfield-avenue', '2012', 'dip', False),
        ('hudson/jersey-city/garfield-avenue', '2016', 'dip', True),
        ('hudson/jersey-city/broadway', '2016', 'spike', True),
        ('hudson/bayonne/broadway', '2010', 'dip', False),
    ]


def test_noted():
    """A `yoy` finding is explained by a data note on its road whose years overlap (a note without
    years covers all)."""
    findings = pd.DataFrame({'entity': [0, 0, 1, 2], 'years': ['2011-2012', '2016', '2020', '2005']})
    notes = pd.DataFrame({
        'entity': pd.array([0, 1, None], dtype='Int32'), 'corridor': pd.array([None, None, 7], dtype='Int32'),
        'year_lo': pd.array([2010, None, 2001], dtype='Int16'), 'year_hi': pd.array([2011, None, 2025], dtype='Int16'),
    })
    from njdot.road_anomalies import noted
    assert noted(findings, notes).tolist() == [True, False, True, False]


def test_yoy_breaks_exclude_noted_years():
    """Road 0's town has its reports missing in 2014–16 (noted): 2017's return to normal isn't a
    spike, and the gap years themselves aren't checked. Without the exclusion 2014–16 is a dip and
    2017 is compared with them."""
    from njdot.road_anomalies import noted_years
    rows = []
    for y in range(2008, 2022):
        rows += [(0, y, 'p', 5 if 2014 <= y <= 2016 else 100, 0), (1, y, 'p', 1000, 0), (2, y, 'p', 1000, 0)]
    s = summary(rows)
    notes = pd.DataFrame({
        'entity': pd.array([0, 0, None], dtype='Int32'), 'corridor': pd.array([None, None, 7], dtype='Int32'),
        'year_lo': pd.array([2014, None, 2001], dtype='Int16'), 'year_hi': pd.array([2016, None, 2003], dtype='Int16'),
    })
    ex = noted_years(notes)
    assert ex == {0: {2014, 2015, 2016}}
    assert noted_years(notes, 'corridor') == {7: {2001, 2002, 2003}}
    assert yoy_breaks(s, ENTS)[['entity', 'years', 'observed', 'expected', 'detail']].values.tolist() == [
        [0, '2014-2016', '5 5 5', '100 100 100', 'dip'],
    ]
    assert len(yoy_breaks(s, ENTS, exclude=ex)) == 0


def test_corridor_noted_years():
    """Corridor 7's members 0 (900 crashes) and 1 (100): road 0's noted years are the corridor's;
    road 1's alone (under half its crashes) aren't. Corridor 8 has a note of its own."""
    from njdot.road_anomalies import corridor_noted_years
    notes = pd.DataFrame({
        'entity': pd.array([0, 1, None], dtype='Int32'), 'corridor': pd.array([None, None, 8], dtype='Int32'),
        'year_lo': pd.array([2014, 2019, 2020], dtype='Int16'), 'year_hi': pd.array([2015, 2019, 2020], dtype='Int16'),
    })
    members = pd.DataFrame({'entity': [0, 1, 2], 'corridor': [7, 7, 8]})
    s = summary([(0, 2010, 'p', 900, 0), (1, 2010, 'p', 100, 0), (2, 2010, 'p', 50, 0)])
    assert corridor_noted_years(notes, members, s) == {7: {2014, 2015}, 8: {2020}}


def test_recode_rules(tmp_path):
    """`recode` rules rewrite raw location fields before recovery (Newark's 2001–02 Broadway crashes,
    coded to CR 649's SRI → CR 667's), and seed `override` with their id."""
    rules = load_overrides(write(tmp_path, """
- id: newark-broadway-cr649
  note: Broadway's 2001-02 crashes were coded to CR 649
  where: {cc: 7, mc: 14, years: [2001, 2002], sri: '07000649__'}
  recode: {sri: '07000667__'}
- id: drop-hudson
  note: a `set` rule, skipped by `apply_recodes`
  where: {cc: 9}
  set: {entity: null}
"""))
    assert [(r.id, r.recode, r.entity) for r in rules] == [('newark-broadway-cr649', {'sri': '07000667__'}, None), ('drop-hudson', None, None)]
    cr = pd.DataFrame([
        {'cc': 7, 'mc': 14.0, 'year': 2001, 'sri': '07000649__', 'mp': np.nan, 'road': 'CR 649', 'cross_street': 'THIRD AVENUE', 'severity': 'p'},
        {'cc': 7, 'mc': 14.0, 'year': 2003, 'sri': '07000649__', 'mp': np.nan, 'road': 'CR 649', 'cross_street': '', 'severity': 'p'},
        {'cc': 7, 'mc': 10.0, 'year': 2001, 'sri': '07000649__', 'mp': 4.2, 'road': 'CR 649', 'cross_street': '', 'severity': 'i'},
    ])
    out, counts = apply_recodes(cr, rules)
    assert counts == {'newark-broadway-cr649': 1}
    assert [(s, None if pd.isna(o) else o) for s, o in zip(out['sri'], out['_recode'])] == [
        ('07000667__', 'newark-broadway-cr649'), ('07000649__', None), ('07000649__', None),
    ]
    # `apply_overrides` skips `recode` rules, and carries `_recode` into `override`.
    be = out.assign(entity=[1, 1, 2]).drop(columns=['mp'])
    kept, counts = apply_overrides(be, rules, ENTS)
    assert counts == {'drop-hudson': 0}
    assert [None if pd.isna(o) else o for o in kept['override']] == ['newark-broadway-cr649', None, None]
    assert '_recode' not in kept


def test_recode_rules_validate(tmp_path):
    with pytest.raises(ValueError, match=r"`recode` keys must be some of \['sri', 'mp', 'road', 'cross_street'\] \(got \['entity'\]\)"):
        load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {cc: 9}\n  recode: {entity: 3}\n"))
    with pytest.raises(ValueError, match=r"runs before recovery; it can't match on \['entity', 'loc_source'\]"):
        load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {entity: a/b, loc_source: sri_mp}\n  recode: {sri: X}\n"))
    with pytest.raises(ValueError, match='has both `set` and `recode`'):
        load_overrides(write(tmp_path, "- id: a\n  note: x\n  where: {cc: 9}\n  recode: {sri: X}\n  set: {entity: null}\n"))
