"""Curated overrides (`njdot.road_overrides`) and the anomaly audit (`njdot.road_anomalies`)."""
import pandas as pd
import pytest

from njdot.road_anomalies import pair_swings, review_queue, unplaced_share, yoy_breaks
from njdot.road_overrides import ROAD_OVERRIDES, apply_overrides, load_overrides

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
