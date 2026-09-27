"""Per-road data notes (`njdot.road_notes`, specs/road-anomalies.md § Data notes)."""
import pandas as pd
import pytest

from njdot.road_notes import LOCAL_SUBT, ROAD_NOTES, gap_notes, load_notes, muni_gaps, road_notes

# Road 0: a Jersey City street; 1: the Turnpike through JC and Bayonne (toll road); 2 / 3: its
# express lanes (corridor 5 with road 1); 4: a Bayonne street.
ENTS = pd.DataFrame({
    'entity': [0, 1, 2, 3, 4],
    'slug': ['hudson/jersey-city/west-side-avenue', 'hudson/new-jersey-turnpike', 'hudson/new-jersey-turnpike-express', 'hudson/tp-express-2', 'hudson/bayonne/broadway'],
    'name': ['West Side Avenue', 'New Jersey Turnpike', 'New Jersey Turnpike Express', 'New Jersey Turnpike Express', 'Broadway'],
    'cc': [9, 9, 9, 9, 9], 'mc': [6, None, 6, 1, 1], 'subt': [7, 4, 4, 4, 5],
    'sris': ['09061684__', '00000095__', '00000095E_', '00000095ES', '09011544__'],
    'lon_min': [-74.08, -74.1, -74.1, -74.1, -74.12], 'lat_min': [40.70, 40.66, 40.66, 40.66, 40.65],
    'lon_max': [-74.06, -74.0, -74.0, -74.0, -74.10], 'lat_max': [40.74, 40.80, 40.80, 40.80, 40.67],
})
# The munis each road runs through: the Turnpike through both.
ENT_MUNIS = pd.DataFrame({'entity': [0, 1, 1, 2, 3, 4], 'cc': [9] * 6, 'mc': [6, 6, 1, 6, 1, 1]})
CORRIDOR = pd.Series({1: 5, 2: 5, 3: 5})


def write(tmp_path, text: str) -> str:
    p = tmp_path / 'notes.yml'
    p.write_text(text)
    return str(p)


NOTES = """
- id: jc
  kind: reporting
  years: [2020, 2025]
  title: JC reports fewer PDO crashes
  text: >
    Jersey City's property-damage reports
    fell 42%.
  where: {cc: 9, mc: 6, subt: [2, 3, 5, 6, 7]}
- id: express
  kind: coding
  years: [2023, 2025]
  title: Express lanes coded from 2023
  text: x
  where: {sris: '(^|,)00000[0-9]{3}E'}
  corridors: true
- id: south
  kind: unexplained
  title: South of 40.7
  text: y
  where: {bbox: [-74.2, 40.6, -74.0, 40.7]}
"""


def test_road_notes(tmp_path):
    notes = load_notes(write(tmp_path, NOTES))
    assert [(n.id, n.kind, n.years, n.title, n.text, n.corridors) for n in notes] == [
        ('jc', 'reporting', (2020, 2025), 'JC reports fewer PDO crashes', "Jersey City's property-damage reports fell 42%.", False),
        ('express', 'coding', (2023, 2025), 'Express lanes coded from 2023', 'x', True),
        ('south', 'unexplained', None, 'South of 40.7', 'y', False),
    ]
    df = road_notes(notes, ENTS, CORRIDOR, ENT_MUNIS)
    assert [tuple(None if pd.isna(v) else v for v in r) for r in df[['entity', 'corridor', 'note', 'kind', 'year_lo', 'year_hi']].values] == [
        # JC's local roads only: not the Turnpike (State Police) through JC.
        (0, None, 'jc', 'reporting', 2020, 2025),
        # The express SRIs' roads, and their corridor's other member (the main line) and the corridor.
        (1, None, 'express', 'coding', 2023, 2025),
        (2, None, 'express', 'coding', 2023, 2025),
        (3, None, 'express', 'coding', 2023, 2025),
        # bbox: the road's bbox center (Bayonne Broadway's 40.66°).
        (4, None, 'south', 'unexplained', None, None),
        (None, 5, 'express', 'coding', 2023, 2025),
    ]
    assert [str(t) for t in df.dtypes] == ['Int32', 'Int32', 'string', 'string', 'Int16', 'Int16', 'string', 'string']
    # The repo's notes parse.
    assert len(load_notes(ROAD_NOTES)) >= 1


def test_load_notes_validates(tmp_path):
    ok = "- id: a\n  kind: coding\n  title: t\n  text: x\n  where: {cc: 9}\n"
    with pytest.raises(ValueError, match="duplicate note id 'a'"):
        load_notes(write(tmp_path, ok + ok))
    with pytest.raises(ValueError, match="`kind` must be one of"):
        load_notes(write(tmp_path, ok.replace('coding', 'other')))
    with pytest.raises(ValueError, match="has no `text`"):
        load_notes(write(tmp_path, ok.replace('  text: x\n', '')))
    with pytest.raises(ValueError, match=r"unknown `where` keys \['town'\]"):
        load_notes(write(tmp_path, ok.replace('{cc: 9}', '{town: 9}')))


def test_muni_gaps_and_gap_notes(tmp_path):
    """Muni (9, 10) has its reports missing in 2021–22 (its county's other muni doesn't dip); (9, 11)
    dips in 2019 with its county's other muni (a county-wide change, not a gap); (9, 12) is too small
    to check. A curated note for (9, 10) 2022 replaces the automatic one."""
    rows = []
    for y in range(2012, 2026):
        rows += [
            (9, 10, y, 30 if y in (2021, 2022) else 1000),
            (9, 11, y, 400 if y == 2019 else 800),
            (9, 20, y, 5000 if y == 2019 else 10000),
            (9, 12, y, 0 if y == 2016 else 60),
        ]
    counts = pd.DataFrame(rows, columns=['cc', 'mc', 'year', 'n'])
    g = muni_gaps(counts)
    assert g.values.tolist() == [[9, 10, 2021, 2022, '30 30', '1000 1000']]
    notes = gap_notes(g, [], {(9, 10): 'Union City'})
    assert [(n.id, n.kind, n.years, n.title, n.where) for n in notes] == [
        ('gap-9-10-2021-2022', 'coverage', (2021, 2022), "Most of Union City's crash reports are missing for 2021–2022", {'cc': 9, 'mc': 10, 'subt': LOCAL_SUBT}),
    ]
    assert notes[0].text == (
        "NJDOT's data has 30 (2021), 30 (2022) crashes in Union City, vs ~1,000 a year expected from the years around them "
        "(and the rest of the county's trend): most of the town's crash reports for 2021–2022 are missing from the data, "
        "so its roads' counts for 2021–2022 are too low."
    )
    curated = load_notes(write(tmp_path, "- id: uc\n  kind: coverage\n  years: 2022\n  title: t\n  text: x\n  where: {cc: 9, mc: 10}\n"))
    assert gap_notes(g, curated) == []
